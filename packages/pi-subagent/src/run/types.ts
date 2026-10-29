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

/** Where a start value came from; `auto` is the classifier of a `model: auto` run. */
export type ValueSource = "call" | "definition" | "parent" | "settings" | "default" | "auto";

/** How demanding an auto run's task is, from the least; each tier can have its own model. */
export const AUTO_TIERS = ["light", "standard", "complex", "deep"] as const;
export type AutoTier = (typeof AUTO_TIERS)[number];

/** How much an auto run's task must reason, from the least; it sets the thinking level. */

export interface RunWorktree {
    repoRoot: string;
    path: string;
    baseCommit: string;
}

/** The classifier's answer to one auto question, and the level the run used. */
export interface AutoRating<T extends string> {
    /** The option the classifier chose. */
    rated: T;
    /** `rated`, or the next level up when the classifier was unsure. */
    used: T;
    /** Pi's measure of how clear the choice was, from 0 (an even split) to 1. */
    confidence: number;
    /** Each option's share of the answer, from 0 to 1. */
    probabilities: Partial<Record<T, number>>;
}

/** The high-risk answer of a rating. */
export interface AutoRisk {
    /** The classifier's probability that a mistake in the task could cause serious harm. */
    probability: number;
    /** The probability from which a task counts as high risk, from the settings. */
    threshold: number;
    high: boolean;
    /** The high-risk floor, when it raised the tier that the model comes from. */
    floor?: AutoTier;
}

/** How `model: auto` resolved the run's model and, unless the start set it, its thinking. */
export type AutoModelChoice =
    | {
          by: "rating";
          /** `provider/id` of the classifier. */
          classifier: string;
          tier: AutoRating<AutoTier>;
          /** The tier whose model the run got, or `main` for the main agent's model. */
          modelFrom: AutoTier | "main";
          /** Absent when the start set the thinking or the run's model supports one level. */
          thinking?: AutoRating<ThinkingLevel>;
          /** Absent for a run that an earlier version started. */
          risk?: AutoRisk;
      }
    /** No classifier is selected, so the run got the main agent's model. */
    | { by: "no-classifier" }
    /** No tier has a model and the start set the thinking, so no classifier ran. */
    | { by: "nothing-to-rate" }
    /** The classifier failed, so the run got the main agent's model, and thinking if unset. */
    | { by: "classifier-failed"; classifier: string; error: string };

/** The values a run started with. Later edits to its definition never change an existing run. */
export interface RunSnapshot {
    runId: string;
    /** The definition name, or `run-<n>` for an inline run. */
    name: string;
    title?: string;
    /** Only for a run started from a definition. */
    definition?: { name: string; body: string; file: string };
    task: string;
    /** `provider/id`. */
    model: string;
    /** Set when the call or definition asked for `auto`; `sources.model` says which. */
    autoModel?: AutoModelChoice;
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
    /** The turn's last report. */
    report?: RunReport;
    /** Reports that a later report of the same turn replaced, oldest first. */
    earlierReports?: RunReport[];
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
