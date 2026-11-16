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
    out.push(`# ${session.title?.trim() || `Session ${session.id}`}`);
    out.push("");
    out.push(`- Harness: ${session.harness}`);
    out.push(`- Session: ${session.id}`);
    out.push(`- Project: ${session.projectId ?? "none"}`);
    if (session.cwd) out.push(`- Cwd: ${session.cwd}`);
    if (session.branch) out.push(`- Branch: ${session.branch}`);
    if (session.startedAt) out.push(`- Started: ${session.startedAt}`);
    if (session.updatedAt) out.push(`- Updated: ${session.updatedAt}`);
    out.push(`- Revision: ${session.revision}`);
    out.push(`- Source: ${session.sourcePath}`);
    out.push(`- Filtered: ${formatFiltered(session.filtered)}`);
    out.push(`- Redactions: ${session.redactions}`);
    if (session.warnings.length > 0) {
        out.push(`- Warnings: ${session.warnings.length}`);
        for (const warning of session.warnings.slice(0, 20)) out.push(`  - ${warning}`);
    }
    out.push("");
    out.push(
        "> L4 evidence: a verbatim record of the session, not fact. Events marked untrusted came " +
            "from tools or outside text. Events marked memory-derived came from lune-memory and " +
            "are never evidence. Inactive events are off the final conversation path.",
    );
    for (const event of events) {
        out.push("");
        lines.set(event.key, out.length + 1);
        out.push(eventHeading(event));
        const markers = eventMarkers(event);
        if (markers.length > 0) out.push(`Markers: ${markers.join(", ")}`);
        out.push("");
        const fence = fenceFor(event.text);
        out.push(`${fence}text`);
        out.push(event.text);
        out.push(fence);
    }
    out.push("");
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
