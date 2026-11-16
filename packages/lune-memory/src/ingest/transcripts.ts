import { existsSync, rmSync } from "node:fs";

import { transcriptFile, type MemoryPaths } from "../core/paths.ts";
import type { EventRow, SessionRow } from "../core/types.ts";
import { writeFileAtomic } from "../core/util.ts";
import type { Store } from "../store/db.ts";
import { listEvents, sessionFromRow } from "../store/rows.ts";

/** Header line of one event in a transcript. Search hits point to this line. */
export function eventHeading(event: EventRow): string {
    const tool = event.toolName ? ` ${event.toolName}` : "";
    const time = event.time ? ` · ${event.time}` : "";
    const source = event.sourceLine ? ` (source L${event.sourceLine})` : "";
    return `## [e:${event.key}] ${event.role}${tool}${time}${source}`;
}

/** Markers of one event: trust and path flags that a reader must see. */
export function eventMarkers(event: EventRow): string[] {
    const markers: string[] = [];
    if (event.untrusted) markers.push("untrusted");
    if (event.memoryDerived) markers.push("memory-derived");
    if (!event.active) markers.push("inactive");
    return markers;
}

/** Lines in `text` when it is written as one entry of the transcript. */
function lineCount(text: string): number {
    let count = 1;
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
    return count;
}

/** A header value on one line, so that it does not shift the lines after it. */
function oneLine(value: string | null | undefined): string {
    return value ? value.replace(/\s+/gu, " ").trim() : "";
}

/** A code fence that is longer than every backtick run in `text`, so the text stays verbatim. */
function fenceFor(text: string): string {
    let longest = 2;
    for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
    return "`".repeat(longest + 1);
}

function formatFiltered(filtered: Record<string, number>): string {
    const entries = Object.entries(filtered).filter(([, count]) => count > 0);
    if (entries.length === 0) return "none";
    return entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ");
}

/**
 * Render the L4 transcript of one session. The transcript keeps the meaning and order of the
 * events, and records role filtering, redaction and trust markers. It returns the text and the
 * 1-based line of each event heading.
 */
export function renderTranscript(
    session: SessionRow,
    events: EventRow[],
): { text: string; lines: Map<string, number> } {
    const out: string[] = [];
    const lines = new Map<string, number>();
    // Lines written so far. One entry of `out` can hold many lines, for example event text.
    let written = 0;
    const push = (...entries: string[]) => {
        for (const entry of entries) {
            out.push(entry);
            written += lineCount(entry);
        }
    };
    push(`# ${oneLine(session.title) || `Session ${session.id}`}`);
    push("");
    push(`- Harness: ${session.harness}`);
    push(`- Session: ${session.id}`);
    push(`- Project: ${session.projectId ?? "none"}`);
    if (session.cwd) push(`- Cwd: ${session.cwd}`);
    if (session.branch) push(`- Branch: ${session.branch}`);
    if (session.startedAt) push(`- Started: ${session.startedAt}`);
    if (session.updatedAt) push(`- Updated: ${session.updatedAt}`);
    push(`- Revision: ${session.revision}`);
    push(`- Source: ${session.sourcePath}`);
    push(`- Filtered: ${formatFiltered(session.filtered)}`);
    if (session.redactions > 0) push(`- Redactions: ${session.redactions}`);
    if (session.warnings.length > 0) {
        push(`- Warnings: ${session.warnings.length}`);
        for (const warning of session.warnings.slice(0, 20)) push(`  - ${oneLine(warning)}`);
    }
    push("");
    push(
        "> L4 evidence: a verbatim record of the session, not fact. Events marked untrusted came " +
            "from tools or outside text. Events marked memory-derived came from lune-memory and " +
            "are never evidence. Inactive events are off the final conversation path.",
    );
    for (const event of events) {
        push("");
        lines.set(event.key, written + 1);
        push(eventHeading(event));
        const markers = eventMarkers(event);
        if (markers.length > 0) push(`Markers: ${markers.join(", ")}`);
        push("");
        const fence = fenceFor(event.text);
        push(`${fence}text`);
        push(event.text);
        push(fence);
    }
    push("");
    return { text: out.join("\n"), lines };
}

/**
 * Write the transcript of one session and record its path and the line of each event. A file
 * at an earlier path is removed. Returns the new path.
 */
export function writeSessionTranscript(
    store: Store,
    paths: MemoryPaths,
    session: SessionRow,
): string {
    const events = listEvents(store, session.harness, session.id);
    const { text, lines } = renderTranscript(session, events);
    const path = transcriptFile(paths, session.projectId, session.harness, session.id);
    writeFileAtomic(path, text, 0o600);
    store.tx(() => {
        store.run(
            "UPDATE sessions SET transcript_path = ? WHERE harness = ? AND id = ?",
            path,
            session.harness,
            session.id,
        );
        for (const [key, line] of lines) {
            store.run(
                "UPDATE events SET transcript_line = ? WHERE harness = ? AND session_id = ? AND key = ?",
                line,
                session.harness,
                session.id,
                key,
            );
        }
    });
    if (session.transcriptPath && session.transcriptPath !== path) {
        removeTranscript(session.transcriptPath);
    }
    return path;
}

/** Remove a transcript file. A missing file is not an error. */
export function removeTranscript(path: string): void {
    try {
        rmSync(path, { force: true });
    } catch {
        // A file that cannot be removed stays. The next relocation tries again.
    }
}

/**
 * Write the transcripts that are missing or at an old path, for example after a project merge,
 * split or register. `projectId` limits the work to the sessions of one project. Returns the
 * number of transcripts written.
 */
export function relocateTranscripts(store: Store, paths: MemoryPaths, projectId?: string): number {
    const rows =
        projectId === undefined
            ? store.all("SELECT * FROM sessions")
            : store.all("SELECT * FROM sessions WHERE project_id = ?", projectId);
    let written = 0;
    for (const row of rows) {
        const session = sessionFromRow(row);
        const expected = transcriptFile(paths, session.projectId, session.harness, session.id);
        if (session.transcriptPath === expected && existsSync(expected)) continue;
        writeSessionTranscript(store, paths, session);
        if (session.transcriptPath && session.transcriptPath !== expected) {
            removeTranscript(session.transcriptPath);
        }
        written++;
    }
    return written;
}
