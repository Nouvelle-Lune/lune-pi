import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HARNESSES, THINKING_LEVELS, type Harness, type Thinking } from "./types.ts";
import { writeFileAtomic } from "./util.ts";

export interface HarnessConfig {
    /** Import sessions of this harness. Off until the user runs `lune-memory setup <harness>`. */
    enabled: boolean;
    /** Directory that holds the native session files. */
    root: string;
}

export interface DreamingConfig {
    /** Run scheduled Dreaming passes in the daemon. A manual `dream` runs in any case. */
    enabled: boolean;
    /** Model as `provider/id`, for example `anthropic/claude-sonnet-4-5`. No model means no pass. */
    model: string | null;
    thinking: Thinking;
    /** A session is eligible after this many hours without a content change. */
    idleHours: number;
    /** Pass budget: at most this many sessions in one pass. */
    maxSessionsPerPass: number;
    /** Pass budget: at most this many characters of events from one session in one pass. */
    maxCharsPerSession: number;
    /** Retry stop point: failed passes per session revision before the revision waits for a change. */
    maxAttempts: number;
    /** Analyzer calls that run at the same time. */
    concurrency: number;
    /** Minutes between eligibility scans in the daemon. */
    scanMinutes: number;
    /** First-run history limit: older sessions go to L4 only and are never analyzed. */
    historyDays: number;
    /** Provider retries for one model call. */
    maxRetries: number;
}

export interface MemoryConfig {
    harnesses: Record<Harness, HarnessConfig>;
    /** Seconds between import scans in the daemon. */
    importSeconds: number;
    /**
     * Start the daemon in the background when a startup hook, the MCP server or the Pi extension
     * needs it and it does not run.
     */
    autoStart: boolean;
    dreaming: DreamingConfig;
    /** Delete L4 events of sessions older than this many days. 0 keeps everything. */
    retentionDays: number;
    /** Projection generations to keep for restore. */
    generations: number;
}

/** Root folder of lune-memory data. `LUNE_MEMORY_HOME` overrides the default. */
export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.LUNE_MEMORY_HOME?.trim();
    return override ? override : join(homedir(), ".lune-memory");
}

/** Default config. CLAUDE_CONFIG_DIR and CODEX_HOME move the Claude Code and Codex roots. */
export function defaultConfig(
    home: string = homedir(),
    env: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
    const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    const codexDir = env.CODEX_HOME?.trim() || join(home, ".codex");
    return {
        harnesses: {
            pi: { enabled: false, root: join(home, ".pi", "agent", "sessions") },
            claude: { enabled: false, root: join(claudeDir, "projects") },
            codex: { enabled: false, root: join(codexDir, "sessions") },
        },
        importSeconds: 60,
        autoStart: true,
        dreaming: {
            enabled: true,
            model: null,
            thinking: "low",
            idleHours: 6,
            maxSessionsPerPass: 8,
            maxCharsPerSession: 80_000,
            maxAttempts: 3,
            concurrency: 3,
            scanMinutes: 10,
            historyDays: 30,
            maxRetries: 2,
        },
        retentionDays: 0,
        generations: 3,
    };
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? value
        : fallback;
}

function int(value: unknown, fallback: number, min: number, max?: number): number {
    return Math.floor(num(value, fallback, min, max));
}

/** Merge a parsed config file with the defaults. Invalid values fall back to the defaults. */
export function normalizeConfig(raw: unknown, home: string = homedir()): MemoryConfig {
    const base = defaultConfig(home);
    const input = record(raw);
    const harnessInput = record(input.harnesses);
    const harnesses = { ...base.harnesses };
    for (const harness of HARNESSES) {
        const entry = record(harnessInput[harness]);
        const root = typeof entry.root === "string" && entry.root.trim() ? entry.root : null;
        harnesses[harness] = {
            enabled: bool(entry.enabled, base.harnesses[harness].enabled),
            root: root ? expandHome(root, home) : base.harnesses[harness].root,
        };
    }
    const d = record(input.dreaming);
    const dd = base.dreaming;
    const model = typeof d.model === "string" && d.model.includes("/") ? d.model.trim() : null;
    const thinking = THINKING_LEVELS.includes(d.thinking as Thinking)
        ? (d.thinking as Thinking)
        : dd.thinking;
    return {
        harnesses,
        importSeconds: int(input.importSeconds, base.importSeconds, 5),
        autoStart: bool(input.autoStart, base.autoStart),
        dreaming: {
            enabled: bool(d.enabled, dd.enabled),
            model,
            thinking,
            idleHours: num(d.idleHours, dd.idleHours, 0),
            maxSessionsPerPass: int(d.maxSessionsPerPass, dd.maxSessionsPerPass, 1, 100),
            maxCharsPerSession: int(d.maxCharsPerSession, dd.maxCharsPerSession, 1000),
            maxAttempts: int(d.maxAttempts, dd.maxAttempts, 1, 100),
            concurrency: int(d.concurrency, dd.concurrency, 1, 16),
            scanMinutes: num(d.scanMinutes, dd.scanMinutes, 1),
            historyDays: num(d.historyDays, dd.historyDays, 0),
            maxRetries: int(d.maxRetries, dd.maxRetries, 0, 10),
        },
        retentionDays: num(input.retentionDays, base.retentionDays, 0),
        generations: int(input.generations, base.generations, 1, 20),
    };
}

function expandHome(path: string, home: string): string {
    if (path === "~") return home;
    if (path.startsWith("~/")) return join(home, path.slice(2));
    return path;
}

export function loadConfig(path: string): MemoryConfig {
    if (!existsSync(path)) return defaultConfig();
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(
            `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    return normalizeConfig(raw);
}

export function saveConfig(path: string, config: MemoryConfig): void {
    writeFileAtomic(path, `${JSON.stringify(config, null, 4)}\n`, 0o600);
}

/** Split `provider/id` on the first `/`. Model ids can contain `/`. */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
    const index = ref.indexOf("/");
    if (index <= 0 || index === ref.length - 1) return null;
    return { provider: ref.slice(0, index), id: ref.slice(index + 1) };
}
