import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
    CURRENT_SESSION_VERSION,
    SessionManager,
    type SessionEntry,
    type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import {
    RUN_ENTRY_TYPE,
    TURN_ENTRY_TYPE,
    type RunSnapshot,
    type RunUsage,
    type TurnRecord,
} from "./types.ts";

/**
 * Create the run file with only its session header, then open it.
 *
 * `SessionManager.create()` names files `<timestamp>_<id>.jsonl` and writes nothing until the first
 * message; an opened file is already flushed, so every entry, the snapshot included, is written at
 * once and the file exists even when the first prompt fails before any message.
 */
export function createRunFile(
    file: string,
    header: { runId: string; cwd: string; parentSessionFile?: string },
): SessionManager {
    const sessionHeader: SessionHeader = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: header.runId,
        timestamp: new Date().toISOString(),
        cwd: header.cwd,
        ...(header.parentSessionFile ? { parentSession: header.parentSessionFile } : {}),
    };

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(sessionHeader)}\n`, { flag: "wx" });

    return SessionManager.open(file, dirname(file));
}

export interface RunFileState {
    snapshot: RunSnapshot;
    lastTurn: TurnRecord | undefined;
    turns: number;
    /**
     * A message follows the last recorded turn end: the parent stopped while the turn ran, before
     * the run could record how it ended.
     */
    unfinishedTurn: boolean;
    usage: RunUsage;
}

/** Open an existing run file. Pi's own `open()` would quietly start an empty session for a missing path. */
export function openRunFile(file: string): SessionManager {
    if (!existsSync(file)) {
        throw new Error(`The run file is missing: ${file}`);
    }

    return SessionManager.open(file, dirname(file));
}

export function readRunFile(file: string): RunFileState {
    return readRunEntries(openRunFile(file).getEntries(), file);
}

export function readRunEntries(entries: readonly SessionEntry[], file: string): RunFileState {
    let snapshot: RunSnapshot | undefined;
    let lastTurn: TurnRecord | undefined;
    let turns = 0;
    let messageAfterTurn = false;

    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE && !snapshot) {
            snapshot = parseSnapshot(entry.data, file);
        } else if (entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE) {
            lastTurn = parseTurnRecord(entry.data, file);
            turns += 1;
            messageAfterTurn = false;
        } else if (
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant")
        ) {
            messageAfterTurn = true;
        }
    }

    if (!snapshot) {
        throw new Error(`The run file has no ${RUN_ENTRY_TYPE} entry: ${file}`);
    }

    return {
        snapshot,
        lastTurn,
        turns,
        unfinishedTurn: messageAfterTurn,
        usage: usageFromEntries(entries),
    };
}

/** The run's own token usage; it is never added to the parent session's totals. */
export function usageFromEntries(entries: readonly SessionEntry[]): RunUsage {
    const totals: RunUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
    };
    const add = (usage: Usage | undefined): void => {
        if (!usage) {
            return;
        }

        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        totals.cost += usage.cost.total;
    };

    // The same entries Pi's own getSessionStats() counts.
    for (const entry of entries) {
        if (entry.type === "usage") {
            add(entry.usage);
        } else if (entry.type === "compaction" || entry.type === "branch_summary") {
            add(entry.usage);
        } else if (entry.type === "message") {
            const message = entry.message;

            if (message.role === "assistant") {
                add(message.usage);
            } else if (message.role === "toolResult") {
                add((message as { usage?: Usage }).usage);
            }
        }
    }

    totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

    return totals;
}

/** Every message of the run, in order; a run session never branches. */
export function transcriptMessages(entries: readonly SessionEntry[]): AgentMessage[] {
    const messages: AgentMessage[] = [];

    for (const entry of entries) {
        if (entry.type === "message") {
            messages.push(entry.message);
        }
    }

    return messages;
}

function parseSnapshot(data: unknown, file: string): RunSnapshot {
    const snapshot = data as Partial<RunSnapshot> | undefined;

    if (
        !snapshot ||
        typeof snapshot.runId !== "string" ||
        typeof snapshot.name !== "string" ||
        typeof snapshot.task !== "string" ||
        typeof snapshot.model !== "string" ||
        typeof snapshot.cwd !== "string" ||
        !Array.isArray(snapshot.tools) ||
        (snapshot.isolation !== "shared" && snapshot.isolation !== "worktree")
    ) {
        throw new Error(`The run file has an invalid ${RUN_ENTRY_TYPE} entry: ${file}`);
    }

    return snapshot as RunSnapshot;
}

function parseTurnRecord(data: unknown, file: string): TurnRecord {
    const record = data as Partial<TurnRecord> | undefined;

    if (
        !record ||
        (record.state !== "idle" && record.state !== "failed" && record.state !== "interrupted")
    ) {
        throw new Error(`The run file has an invalid ${TURN_ENTRY_TYPE} entry: ${file}`);
    }

    return record as TurnRecord;
}
