import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../../src/definitions.ts";
import { definitionsDir, runSessionFile } from "../../src/paths.ts";
import { createRunFile } from "../../src/run/run-file.ts";
import { RunManager } from "../../src/run/run-manager.ts";
import { Run, type RunHost } from "../../src/run/run.ts";
import {
    RUN_ENTRY_TYPE,
    TURN_ENTRY_TYPE,
    type RunSnapshot,
    type SpawnEntryData,
    type TurnRecord,
} from "../../src/run/types.ts";

/** A temp agent directory; `PI_CODING_AGENT_DIR` points at it so nothing reads the real one. */
export function tempAgentDir(t: TestContext): string {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-"));
    const agentDir = join(root, "agent");
    const previous = process.env["PI_CODING_AGENT_DIR"];

    mkdirSync(agentDir, { recursive: true });
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    t.after(() => {
        if (previous === undefined) {
            delete process.env["PI_CODING_AGENT_DIR"];
        } else {
            process.env["PI_CODING_AGENT_DIR"] = previous;
        }

        rmSync(root, { recursive: true, force: true });
    });

    return agentDir;
}

export function writeDefinition(agentDir: string, fileName: string, content: string): string {
    const dir = definitionsDir(agentDir);
    const file = join(dir, fileName);

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);

    return file;
}

/** `tag: true` wraps every styled span as `<color:text>`, so a test can see the colour token. */
export function fakeTheme(options: { tag?: boolean } = {}): Theme {
    const tag = options.tag === true;

    return {
        fg: (color: string, text: string) => (tag ? `<${color}:${text}>` : text),
        bg: (color: string, text: string) => (tag ? `[${color}:${text}]` : text),
        bold: (text: string) => text,
        style: (text: string) => text,
        colors: {},
    } as unknown as Theme;
}

export function definition(
    name: string,
    overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
    return {
        name,
        description: `The ${name} agent.`,
        body: "",
        file: `/defs/${name}.md`,
        ...overrides,
    };
}

export function snapshot(runId: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
        runId,
        name: runId,
        task: "Do the task.",
        model: "test/model",
        thinking: "off",
        tools: ["read", "report"],
        sources: { model: "parent", thinking: "parent", tools: "settings", isolation: "default" },
        isolation: "shared",
        cwd: "/work",
        parentSessionId: "parent",
        spawnEntryId: "spawn",
        createdAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

export function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
    return {
        state: "idle",
        userWrote: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:04.200Z",
        ...overrides,
    };
}

export function userMessage(text: string): AgentMessage {
    return { role: "user", content: text, timestamp: 1 };
}

export function assistantMessage(
    text: string,
    usage: { input?: number; output?: number; cost?: number } = {},
): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "test",
        model: "model",
        usage: {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: (usage.input ?? 0) + (usage.output ?? 0),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
        },
        stopReason: "stop",
        timestamp: 2,
    } as AgentMessage;
}

export interface RunFileSpec {
    snapshot?: Partial<RunSnapshot>;
    /** Messages written before the turn records. */
    messages?: AgentMessage[];
    turns?: TurnRecord[];
}

/** Writes a complete run file at the layout path of a temp agent dir and returns its path. */
export function writeRunFile(
    agentDir: string,
    parentId: string,
    runId: string,
    spec: RunFileSpec = {},
): string {
    const file = runSessionFile(parentId, runId, agentDir);
    const manager = createRunFile(file, { runId, cwd: "/work" });

    manager.appendCustomEntry(
        RUN_ENTRY_TYPE,
        snapshot(runId, { parentSessionId: parentId, ...spec.snapshot }),
    );

    for (const message of spec.messages ?? []) {
        manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
    }

    for (const record of spec.turns ?? []) {
        manager.appendCustomEntry(TURN_ENTRY_TYPE, record);
    }

    return file;
}

export function runHost(agentDir: string, theme: Theme = fakeTheme()): RunHost {
    return {
        agentDir,
        projectTrusted: () => true,
        theme: () => theme,
        onChange: () => undefined,
        onTurnEnd: () => undefined,
    };
}

/** A run restored from a file written by `writeRunFile`. */
export function restoredRun(agentDir: string, runId: string, spec: RunFileSpec = {}): Run {
    const file = writeRunFile(agentDir, "parent", runId, spec);

    return Run.restore(
        { id: runId, file, spawnEntryId: "spawn", parentSessionId: "parent", readOnly: false },
        runHost(agentDir),
    );
}

/** A widget given to `setWidget` as a component factory instead of plain lines. */
export type WidgetFactory = () => { render(width: number): string[] };

export interface FakeUiState {
    notifications: Array<{ message: string; type: string | undefined }>;
    widgets: Array<{
        key: string;
        content: string[] | WidgetFactory | undefined;
        options?: unknown;
    }>;
}

export function fakeCtx(
    options: { sessionManager?: SessionManager; mode?: string; theme?: Theme } = {},
): { ctx: ExtensionContext; ui: FakeUiState } {
    const state: FakeUiState = { notifications: [], widgets: [] };
    const ui = {
        theme: options.theme ?? fakeTheme(),
        notify: (message: string, type?: string) => state.notifications.push({ message, type }),
        setWidget: (
            key: string,
            content: string[] | WidgetFactory | undefined,
            options?: unknown,
        ) => state.widgets.push({ key, content, options }),
    };
    const ctx = {
        ui,
        mode: options.mode ?? "tui",
        hasUI: true,
        cwd: "/work",
        sessionManager: options.sessionManager ?? SessionManager.inMemory("/work"),
        scopedModels: [],
        modelRegistry: { getAvailable: () => [] },
        isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    return { ctx, ui: state };
}

export interface SentMessage {
    customType: string;
    content: string;
    display: boolean;
    details: { runs: Array<{ runId: string }> };
}

export interface FakePi {
    api: ExtensionAPI;
    handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
    tools: Map<string, { name: string; [key: string]: unknown }>;
    commands: Map<
        string,
        { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }
    >;
    renderers: Map<string, unknown>;
    sent: Array<{ message: SentMessage; options: unknown }>;
    /** Make the next `count` calls of `sendMessage` throw; `Infinity` keeps throwing. */
    failSends(count: number): void;
}

export function fakePi(): FakePi {
    let failures = 0;
    const pi: FakePi = {
        handlers: new Map(),
        tools: new Map(),
        commands: new Map(),
        renderers: new Map(),
        sent: [],
        failSends: (count) => {
            failures = count;
        },
        api: undefined as unknown as ExtensionAPI,
    };

    pi.api = {
        on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
            pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]);
        },
        registerTool(tool: { name: string }) {
            pi.tools.set(tool.name, tool);
        },
        registerCommand(
            name: string,
            options: { handler: (args: string, ctx: ExtensionContext) => unknown },
        ) {
            pi.commands.set(name, options);
        },
        registerMessageRenderer(type: string, renderer: unknown) {
            pi.renderers.set(type, renderer);
        },
        sendMessage(message: SentMessage, options: unknown) {
            if (failures > 0) {
                failures -= 1;
                throw new Error("stale runtime");
            }

            pi.sent.push({ message, options });
        },
    } as unknown as ExtensionAPI;

    return pi;
}

/**
 * A parent session with real run files. `spawn` writes the run file and the parent's spawn entry
 * like `subagent_start` does, so `RunManager.restore()` finds the run again.
 */
export function parentSession(t: TestContext, agentDir: string) {
    const sessionManager = SessionManager.inMemory("/work");
    const { ctx, ui } = fakeCtx({ sessionManager });
    const pi = fakePi();
    const parentId = sessionManager.getSessionId();
    const managers: RunManager[] = [];

    t.after(async () => {
        for (const manager of managers) {
            await manager.shutdown();
        }
    });

    return {
        ctx,
        ui,
        pi,
        sessionManager,
        parentId,
        spawn(runId: string, spec: RunFileSpec = {}): void {
            const file = writeRunFile(agentDir, parentId, runId, spec);
            const data: SpawnEntryData = { runId, sessionFile: file, parentSessionId: parentId };

            sessionManager.appendCustomEntry(RUN_ENTRY_TYPE, data);
        },
        manager(definitions: readonly AgentDefinition[] = []): RunManager {
            const manager = new RunManager({ pi: pi.api, ctx, agentDir, definitions });

            manager.restore();
            managers.push(manager);

            return manager;
        },
    };
}
