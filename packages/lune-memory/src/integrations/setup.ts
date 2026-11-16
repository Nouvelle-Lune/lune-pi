import { accessSync, constants, copyFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { cliPath } from "../client/connection.ts";
import type { Harness } from "../core/types.ts";
import { writeFileAtomic } from "../core/util.ts";

/** Harnesses that get L1 from a SessionStart hook. Pi gets L1 from its extension. */
export type HookHarness = Exclude<Harness, "pi">;

export function isHookHarness(value: unknown): value is HookHarness {
    return value === "claude" || value === "codex";
}

/** Session sources that start a new context. Each one needs L1 again. */
const HOOK_MATCHERS: Record<HookHarness, string> = {
    claude: "^(startup|resume|clear|compact|fork)$",
    codex: "startup|resume|clear|compact",
};

/** Seconds that the harness waits for the hook. The hook falls back to the local service. */
const HOOK_TIMEOUT_SECONDS = 30;

export interface HookFiles {
    /** JSON file that holds the SessionStart hook. */
    hooks: string;
    /** Codex config with the feature flag that turns hooks on. */
    codexConfig?: string;
}

/** Config files of a harness. CLAUDE_CONFIG_DIR and CODEX_HOME move them. */
export function hookFiles(
    harness: HookHarness,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): HookFiles {
    if (harness === "claude") {
        const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
        return { hooks: join(dir, "settings.json") };
    }
    const dir = env.CODEX_HOME || join(home, ".codex");
    return { hooks: join(dir, "hooks.json"), codexConfig: join(dir, "config.toml") };
}

/** Full path of an executable on PATH, or null. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
    const names =
        process.platform === "win32"
            ? (env.PATHEXT ?? ".EXE;.CMD;.BAT")
                  .split(";")
                  .map((ext) => `${name}${ext.toLowerCase()}`)
            : [name];
    for (const dir of dirs) {
        for (const file of names) {
            const path = join(dir, file);
            try {
                if (!statSync(path).isFile()) continue;
                if (process.platform !== "win32") accessSync(path, constants.X_OK);
                return path;
            } catch {
                // Not here.
            }
        }
    }
    return null;
}

function quote(value: string): string {
    return /^[\w@%+=:,./-]+$/u.test(value) ? value : `"${value.replace(/(["\\$`])/gu, "\\$1")}"`;
}

export interface CommandOptions {
    /** Memory home to pass with --home. Null or undefined uses the default home. */
    memoryHome?: string | null;
    /** Use `lune-memory` from PATH. The default checks PATH. */
    onPath?: boolean;
    env?: NodeJS.ProcessEnv;
}

/** Start of a command that runs the CLI: `lune-memory` from PATH, or node with the CLI file. */
export function cliCommand(options: CommandOptions = {}): string {
    const onPath = options.onPath ?? findExecutable("lune-memory", options.env) !== null;
    const base = onPath
        ? "lune-memory"
        : [process.execPath, "--disable-warning=ExperimentalWarning", cliPath()]
              .map(quote)
              .join(" ");
    return options.memoryHome ? `${base} --home ${quote(options.memoryHome)}` : base;
}

/** Command of the SessionStart hook. */
export function hookCommand(harness: HookHarness, options: CommandOptions = {}): string {
    return `${cliCommand(options)} hook --harness ${harness}`;
}

/** Command that registers the MCP server with a harness. Setup prints it and does not run it. */
export function mcpAddCommand(harness: HookHarness, options: CommandOptions = {}): string {
    const server = `${cliCommand(options)} mcp --harness ${harness}`;
    return harness === "claude"
        ? `claude mcp add --scope user lune-memory -- ${server}`
        : `codex mcp add lune-memory -- ${server}`;
}

/** Command that adds the Pi extension of this package. */
export function piInstallCommand(): string {
    return `pi install ${quote(resolve(cliPath(), "..", ".."))}`;
}

/**
 * True for a hook command that lune-memory wrote. It runs the lune-memory CLI and the hook
 * subcommand. Hooks of other tools stay as they are.
 */
export function isMemoryHookCommand(command: unknown): boolean {
    return (
        typeof command === "string" &&
        command.includes("lune-memory") &&
        /\shook\s+--harness\s/u.test(command)
    );
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Session start groups without the lune-memory hooks. Groups with no hook left go away. */
function withoutMemoryHooks(groups: unknown[]): { groups: unknown[]; removed: number } {
    let removed = 0;
    const kept: unknown[] = [];
    for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
            kept.push(group);
            continue;
        }
        const hooks = group.hooks.filter(
            (hook) => !(isObject(hook) && isMemoryHookCommand(hook.command)),
        );
        removed += group.hooks.length - hooks.length;
        if (hooks.length)
            kept.push(hooks.length === group.hooks.length ? group : { ...group, hooks });
    }
    return { groups: kept, removed };
}

function hooksTable(settings: Json): Json {
    if (settings.hooks === undefined) return {};
    if (!isObject(settings.hooks))
        throw new Error("The hooks value of the settings file is not an object");
    return settings.hooks;
}

function sessionStartGroups(hooks: Json): unknown[] {
    if (hooks.SessionStart === undefined) return [];
    if (!Array.isArray(hooks.SessionStart)) throw new Error("hooks.SessionStart is not a list");
    return hooks.SessionStart;
}

/** Settings with exactly one lune-memory SessionStart hook. Other settings stay as they are. */
export function addMemoryHook(settings: unknown, harness: HookHarness, command: string): Json {
    if (!isObject(settings)) throw new Error("The settings file does not hold a JSON object");
    const hooks = hooksTable(settings);
    const { groups } = withoutMemoryHooks(sessionStartGroups(hooks));
    groups.push({
        matcher: HOOK_MATCHERS[harness],
        hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    return { ...settings, hooks: { ...hooks, SessionStart: groups } };
}

/** Settings without the lune-memory SessionStart hooks. Empty tables go away. */
export function removeMemoryHook(settings: unknown): { settings: Json; removed: number } {
    if (!isObject(settings)) throw new Error("The settings file does not hold a JSON object");
    if (settings.hooks === undefined) return { settings, removed: 0 };
    const hooks = hooksTable(settings);
    const { groups, removed } = withoutMemoryHooks(sessionStartGroups(hooks));
    if (!removed) return { settings, removed };
    const { SessionStart: _old, ...rest } = hooks;
    const nextHooks: Json = groups.length ? { ...rest, SessionStart: groups } : rest;
    const { hooks: _hooks, ...others } = settings;
    return {
        settings: Object.keys(nextHooks).length ? { ...others, hooks: nextHooks } : others,
        removed,
    };
}

/**
 * Codex config text with `hooks = true` in the [features] table. It changes only that one key
 * and keeps the rest of the text as it is.
 */
export function enableCodexHooks(text: string): { text: string; changed: boolean } {
    if (/^\s*features\.hooks\s*=\s*true\b/mu.test(text)) return { text, changed: false };
    const lines = text.split("\n");
    const header = lines.findIndex((line) => /^\s*\[features\]\s*(#.*)?$/u.test(line));
    if (header === -1) {
        const dotted = lines.findIndex((line) => /^\s*features\.hooks\s*=/u.test(line));
        if (dotted !== -1) {
            lines[dotted] = "features.hooks = true";
            return { text: lines.join("\n"), changed: true };
        }
        const base = text.length && !text.endsWith("\n") ? `${text}\n` : text;
        const gap = base.trim().length ? "\n" : "";
        return { text: `${base}${gap}[features]\nhooks = true\n`, changed: true };
    }
    let end = lines.length;
    for (let index = header + 1; index < lines.length; index += 1) {
        if (/^\s*\[/u.test(lines[index] ?? "")) {
            end = index;
            break;
        }
    }
    for (let index = header + 1; index < end; index += 1) {
        const line = lines[index] ?? "";
        if (!/^\s*hooks\s*=/u.test(line)) continue;
        if (/^\s*hooks\s*=\s*true\b/u.test(line)) return { text, changed: false };
        lines[index] = "hooks = true";
        return { text: lines.join("\n"), changed: true };
    }
    lines.splice(header + 1, 0, "hooks = true");
    return { text: lines.join("\n"), changed: true };
}

function readOptional(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

function parseSettings(path: string, text: string | null): unknown {
    if (text === null || !text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${path} is not valid JSON, so setup does not change it: ${(error as Error).message}`,
            { cause: error },
        );
    }
}

function stamp(now: Date): string {
    return now
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d+Z$/u, "Z");
}

export interface FileChange {
    file: string;
    changed: boolean;
    /** Copy of the file before the change, or null when the file was new or did not change. */
    backup: string | null;
}

/** Write `next` when it differs. A copy of the old file goes next to it first. */
function writeWithBackup(file: string, old: string | null, next: string, now: Date): FileChange {
    if (old === next) return { file, changed: false, backup: null };
    let backup: string | null = null;
    let mode: number | undefined;
    if (old !== null) {
        backup = `${file}.lune-memory-backup.${stamp(now)}`;
        copyFileSync(file, backup);
        mode = statSync(file).mode & 0o777;
    }
    writeFileAtomic(file, next, mode);
    return { file, changed: true, backup };
}

export interface HookSetupOptions {
    command?: string;
    env?: NodeJS.ProcessEnv;
    /** User home folder. The default is the home of the current user. */
    userHome?: string;
    now?: Date;
}

export interface HookInstallResult {
    hooks: FileChange;
    /** The Codex feature flag change. Undefined for Claude. */
    feature?: FileChange;
    command: string;
}

/**
 * Install the SessionStart hook that delivers L1. This changes the harness config, so only an
 * explicit setup step that the user runs calls it.
 */
export function installHook(
    harness: HookHarness,
    options: HookSetupOptions = {},
): HookInstallResult {
    const files = hookFiles(harness, options.env, options.userHome);
    const now = options.now ?? new Date();
    const command =
        options.command ?? hookCommand(harness, options.env ? { env: options.env } : {});
    const old = readOptional(files.hooks);
    const next = `${JSON.stringify(addMemoryHook(parseSettings(files.hooks, old), harness, command), null, 2)}\n`;
    const result: HookInstallResult = {
        hooks: writeWithBackup(files.hooks, old, next, now),
        command,
    };
    if (files.codexConfig) {
        const config = readOptional(files.codexConfig);
        const flagged = enableCodexHooks(config ?? "");
        result.feature = writeWithBackup(files.codexConfig, config, flagged.text, now);
    }
    return result;
}

/** Remove the lune-memory SessionStart hook. The Codex feature flag stays, other hooks can use it. */
export function removeHook(
    harness: HookHarness,
    options: Omit<HookSetupOptions, "command"> = {},
): FileChange & { removed: number } {
    const files = hookFiles(harness, options.env, options.userHome);
    const old = readOptional(files.hooks);
    if (old === null) return { file: files.hooks, changed: false, backup: null, removed: 0 };
    const { settings, removed } = removeMemoryHook(parseSettings(files.hooks, old));
    if (!removed) return { file: files.hooks, changed: false, backup: null, removed };
    const next = `${JSON.stringify(settings, null, 2)}\n`;
    return { ...writeWithBackup(files.hooks, old, next, options.now ?? new Date()), removed };
}

/** True when the hook file holds a lune-memory SessionStart hook. */
export function hookInstalled(
    harness: HookHarness,
    options: Pick<HookSetupOptions, "env" | "userHome"> = {},
): boolean {
    const files = hookFiles(harness, options.env, options.userHome);
    try {
        const settings = parseSettings(files.hooks, readOptional(files.hooks));
        if (!isObject(settings) || !isObject(settings.hooks)) return false;
        const groups = settings.hooks.SessionStart;
        if (!Array.isArray(groups)) return false;
        return groups.some(
            (group) =>
                isObject(group) &&
                Array.isArray(group.hooks) &&
                group.hooks.some((hook) => isObject(hook) && isMemoryHookCommand(hook.command)),
        );
    } catch {
        return false;
    }
}
