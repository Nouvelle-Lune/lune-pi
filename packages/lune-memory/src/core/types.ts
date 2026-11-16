/** Harnesses that lune-memory can import sessions from. A harness identifies the source only. */
export type Harness = "pi" | "claude" | "codex";

export const HARNESSES: readonly Harness[] = ["pi", "claude", "codex"];

export function isHarness(value: unknown): value is Harness {
    return value === "pi" || value === "claude" || value === "codex";
}

/**
 * Role of one imported event.
 *
 * - `summary`: a compaction or branch summary that the harness generated.
 * - `notice`: a runtime marker, such as an aborted turn or a rollback.
 */
export type EventRole = "user" | "assistant" | "tool_call" | "tool_result" | "summary" | "notice";

/** Trust level of a memory item: a user statement, tool-verified evidence, or an agent inference. */
export type Trust = "user" | "tool" | "inference";

export const TRUST_RANK: Record<Trust, number> = { inference: 0, tool: 1, user: 2 };

export type ItemKind =
    | "decision"
    | "lesson"
    | "fact"
    | "open_item"
    | "reference"
    | "preference"
    | "working_state"
    | "wiki"
    | "index"
    | "note";

/** Kinds that an agent can give a note. Index, wiki and working state belong to Dreaming. */
export const NOTE_KINDS: readonly ItemKind[] = [
    "note",
    "decision",
    "lesson",
    "fact",
    "open_item",
    "reference",
    "preference",
];

export type ItemStatus = "active" | "provisional" | "retired" | "source-missing";

export type ItemScope = "global" | "project";

/** Who created an item: a Dreaming pass, or an agent through `note_write`. */
export type ItemOrigin = "dreaming" | "agent_note";

/** Reference from an item to its evidence. */
export type SourceRef =
    | { kind: "event"; harness: Harness; sessionId: string; eventKey: string }
    | { kind: "item"; itemId: string };

export interface Item {
    id: string;
    scope: ItemScope;
    projectId: string | null;
    kind: ItemKind;
    title: string;
    body: string;
    branch: string | null;
    trust: Trust;
    status: ItemStatus;
    origin: ItemOrigin;
    general: boolean;
    writerHarness: Harness | null;
    writerSession: string | null;
    idemKey: string | null;
    contentHash: string;
    createdRun: number | null;
    updatedRun: number | null;
    createdAt: string;
    updatedAt: string;
    sources: SourceRef[];
}

export interface Project {
    id: string;
    name: string;
    root: string | null;
    mergedInto: string | null;
    createdAt: string;
}

export type LocatorKind = "git_common_dir" | "remote" | "path";

export const LOCATOR_KINDS: readonly LocatorKind[] = ["git_common_dir", "remote", "path"];

export function isLocatorKind(value: unknown): value is LocatorKind {
    return typeof value === "string" && (LOCATOR_KINDS as readonly string[]).includes(value);
}

export interface SessionRow {
    harness: Harness;
    id: string;
    sourcePath: string;
    sourceSize: number;
    sourceMtime: number;
    fingerprint: string;
    revision: number;
    cwd: string | null;
    branch: string | null;
    projectId: string | null;
    title: string | null;
    startedAt: string | null;
    updatedAt: string | null;
    changedAt: string;
    importedAt: string;
    transcriptPath: string | null;
    status: "ok" | "error";
    lastError: string | null;
    attempts: number;
    attemptRevision: number | null;
    processedRevision: number | null;
    /**
     * Latest revision whose import removed events of the session. Items that cite the
     * session wait for review until a pass of this revision or a later one clears it. Only the
     * store sets it: `putSession` does not write it.
     */
    reviewRevision?: number | null;
    warnings: string[];
    filtered: Record<string, number>;
    redactions: number;
}

export interface EventRow {
    harness: Harness;
    sessionId: string;
    key: string;
    seq: number;
    role: EventRole;
    toolName: string | null;
    text: string;
    time: string | null;
    sourceLine: number | null;
    transcriptLine: number | null;
    memoryDerived: boolean;
    untrusted: boolean;
    active: boolean;
    hash: string;
    processedHash: string | null;
    /** Characters of a pending event that a pass analyzed. Null when none or all. */
    processedChars: number | null;
}

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: readonly Thinking[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

/** Tag that wraps injected L1 context. Text that contains it is memory-derived. */
export const MEMORY_CONTEXT_TAG = "lune-memory-context";
