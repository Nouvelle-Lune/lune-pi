import type { EventRole, Harness } from "../core/types.ts";

/** One event of unified Session Evidence. */
export interface EvidenceEvent {
    /**
     * Stable identity within the session. A later revision of the same session gives the same
     * key to the same event, so import can compare revisions event by event.
     */
    key: string;
    role: EventRole;
    /** Plain text of the event. Import redacts secrets after the adapter returns. */
    text: string;
    /** ISO time of the event, when the harness recorded one. */
    time?: string;
    /** Tool name for `tool_call` and `tool_result` events. */
    toolName?: string;
    /** 1-based line of the record in the source file. */
    sourceLine: number;
    /** The content came from lune-memory itself: injected L1, a memory file read, or a memory tool. */
    memoryDerived: boolean;
    /** The content came from outside the conversation, such as tool output or fetched text. */
    untrusted: boolean;
    /** False when the event is off the active conversation path: rolled back or on an abandoned branch. */
    active: boolean;
}

/** Unified Session Evidence that one adapter produces from one native session file. */
export interface SessionEvidence {
    harness: Harness;
    sessionId: string;
    sourcePath: string;
    /** Working directory where the session started. The Project Resolver assigns the project. */
    cwd?: string;
    /** Git branch that the harness recorded for the session, if any. */
    branch?: string;
    title?: string;
    startedAt?: string;
    /** Time of the latest event. */
    updatedAt?: string;
    /** Events in conversation order. */
    events: EvidenceEvent[];
    /** Counts of records and content that the adapter filtered out, by reason. */
    filtered: Record<string, number>;
    /** Non-fatal problems, for example a malformed line. */
    warnings: string[];
}

export interface SessionFileRef {
    harness: Harness;
    path: string;
    size: number;
    mtimeMs: number;
}

/** True when a text names a lune-memory file. The importer builds it from the memory home. */
export type MemoryPathTest = (text: string) => boolean;

/** Facts of this install that an adapter needs to classify events. */
export interface ParseContext {
    /**
     * Extra test for memory file paths. The adapters always know the default home; this test
     * also covers a custom `LUNE_MEMORY_HOME` and the real path behind a symlink.
     */
    memoryPath?: MemoryPathTest;
}

export interface HarnessAdapter {
    harness: Harness;
    /** List candidate session files below `root`. Read-only. */
    discover(root: string): SessionFileRef[];
    /**
     * Parse one session file. Return `null` when the file is a known kind that is not a
     * conversation session, for example a subagent rollout. Throw `AdapterFormatError` when a
     * critical record has an unknown format.
     */
    parse(path: string, text: string, context?: ParseContext): SessionEvidence | null;
}

/** An unknown critical format. Import records it on the session and never drops events silently. */
export class AdapterFormatError extends Error {
    override name = "AdapterFormatError";
}
