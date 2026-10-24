import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Custom type of the parent's spawn entry and of the snapshot entry in the run file. */
export const RUN_ENTRY_TYPE = "lune-subagent-run";

/** Custom type of the entry a run file gets when one of its turns ends. */
export const TURN_ENTRY_TYPE = "lune-subagent-turn";

export const ISOLATION_MODES = ["shared", "worktree"] as const;
export type Isolation = (typeof ISOLATION_MODES)[number];

export const REPORT_STATUSES = ["done", "blocked", "needs_input"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const satisfies readonly ThinkingLevel[];

// Pi exports no list of its levels; this fails to compile when Pi adds one.
const _allLevelsListed: [Exclude<ThinkingLevel, (typeof THINKING_LEVELS)[number]>] extends [never]
    ? true
    : never = true;
void _allLevelsListed;

/** The state describes the session; the report status describes the task. */
export type RunState = "running" | "idle" | "failed" | "interrupted";
export type SettledState = Exclude<RunState, "running">;

export interface RunReport {
    status: ReportStatus;
    summary: string;
    /** Set for `blocked`. */
    reason?: string;
    /** Set for `needs_input`. */
    question?: string;
}

/** Where a start value came from. */
export type ValueSource = "call" | "definition" | "parent" | "settings" | "default";

export interface RunWorktree {
    repoRoot: string;
    path: string;
    baseCommit: string;
}

/** The values a run started with. Later edits to its definition never change an existing run. */
export interface RunSnapshot {
    runId: string;
    /** The definition name, or `run-<n>` for an inline run. */
    name: string;
    /** Only for a run started from a definition. */
    definition?: { name: string; body: string; file: string };
    task: string;
    /** `provider/id`. */
    model: string;
    thinking: ThinkingLevel;
    /** The effective SDK allowlist, `report` included. */
    tools: string[];
    sources: {
        model: ValueSource;
        thinking: ValueSource;
        tools: ValueSource;
        isolation: ValueSource;
    };
    isolation: Isolation;
    /** The run's working directory: the parent's, or the matching folder in the worktree. */
    cwd: string;
    worktree?: RunWorktree;
    parentSessionId: string;
    parentSessionFile?: string;
    spawnEntryId: string;
    createdAt: string;
}

/** The parent's branch entry. A run's state lives only in its own file. */
export interface SpawnEntryData {
    runId: string;
    sessionFile: string;
    parentSessionId: string;
}

/** Who stopped a turn. */
export type StopSource = "main-agent" | "user" | "branch" | "shutdown";

export interface TurnRecord {
    state: SettledState;
    report?: RunReport;
    error?: string;
    /** The run's last text, kept when the turn ended without `report`. */
    unreportedMessage?: string;
    /** The user wrote to the run from the inspector during this turn. */
    userWrote: boolean;
    stoppedBy?: StopSource;
    startedAt: string;
    endedAt: string;
}

export interface RunUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
}
