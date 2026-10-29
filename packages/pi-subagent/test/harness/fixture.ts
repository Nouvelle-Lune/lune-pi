import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    type AssistantMessage,
    type FauxProviderHandle,
    type FauxResponseFactory,
    type Model,
} from "@earendil-works/pi-ai";
import {
    ModelRuntime,
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";

import type { AutoModelSettings } from "../../src/auto-model.ts";
import type { AgentDefinition } from "../../src/definitions.ts";
import type { ExtensionTool } from "../../src/extension-tools.ts";
import type { ModelRef } from "../../src/models.ts";
import { RunManager } from "../../src/run/run-manager.ts";
import type { Run } from "../../src/run/run.ts";
import type { LiveSession } from "../../src/run/run-session.ts";
import type { ReportStatus } from "../../src/run/types.ts";
import { createFakeTheme } from "./theme.ts";
import { createGate, within, type Gate } from "./wait.ts";

export interface SentMessage {
    message: { customType: string; content: unknown; display: boolean; details?: unknown };
    options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

/** The two ExtensionAPI members the package uses; `appendEntry` writes to the real parent session. */
export class FakePi {
    readonly sent: SentMessage[] = [];
    private waiters: Array<() => void> = [];
    private readonly parent: SessionManager;

    constructor(parent: SessionManager) {
        this.parent = parent;
    }

    appendEntry = (customType: string, data?: unknown): void => {
        this.parent.appendCustomEntry(customType, data);
    };

    sendMessage = (message: SentMessage["message"], options?: SentMessage["options"]): void => {
        this.sent.push({ message, options });

        for (const waiter of this.waiters.splice(0)) {
            waiter();
        }
    };

    /** Resolves once at least `count` messages were sent. */
    async waitForMessages(count: number, ms = 20_000): Promise<SentMessage[]> {
        await within(
            (async () => {
                while (this.sent.length < count) {
                    await new Promise<void>((resolve) => this.waiters.push(resolve));
                }
            })(),
            `${count} sent message(s), have ${this.sent.length}`,
            ms,
        );

        return this.sent;
    }

    asApi(): ExtensionAPI {
        return this as unknown as ExtensionAPI;
    }
}

export interface FakeCtxState {
    hasUI: boolean;
    model: Model<string> | undefined;
    scopedModels: Array<{ model: Model<string> }>;
    thinkingLevel: string | undefined;
    projectTrusted: boolean;
    /** Whether the main agent is idle; `ctx.isIdle()` answers it. */
    idle: boolean;
    /** Whether the main agent's run is being aborted; `ctx.signal` is then an aborted signal. */
    aborted: boolean;
    /** What `ui.select` answers; undefined is a cancelled dialog. */
    selectAnswer: string | undefined;
    readonly selectCalls: Array<{ title: string; options: string[] }>;
    readonly notifications: Array<{ message: string; type?: string }>;
}

export interface Fixture {
    root: string;
    agentDir: string;
    cwd: string;
    parent: SessionManager;
    pi: FakePi;
    runtime: ModelRuntime;
    faux: FauxProviderHandle;
    models: { first: Model<string>; second: Model<string> };
    state: FakeCtxState;
    ctx: ExtensionContext;
    /** A manager over the parent session; it is shut down when the test ends. */
    createManager(
        definitions?: readonly AgentDefinition[],
        ctx?: ExtensionContext,
        extensionTools?: () => readonly ExtensionTool[],
        autoModelSettings?: (ctx: ExtensionContext) => Promise<AutoModelSettings>,
        modelSelection?: (ctx: ExtensionContext) => Promise<readonly ModelRef[]>,
    ): RunManager;
}

/**
 * An offline parent session: a real SessionManager in a temp folder, a faux provider with two
 * models, and a manager over them. The agent directory is a temp folder and the environment points
 * at it too, so nothing reaches the real `~/.pi/agent`.
 */
export async function createFixture(
    t: TestContext,
    options: { cwd?: string } = {},
): Promise<Fixture> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-")));
    const agentDir = join(root, "agent");
    const cwd = options.cwd ?? join(root, "work");
    const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
    const managers: RunManager[] = [];

    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    process.env["PI_CODING_AGENT_DIR"] = agentDir;

    t.after(async () => {
        // Runs first and last-in: sessions must close before their folders go away.
        for (const manager of managers) {
            await manager.shutdown();
        }

        if (previousAgentDir === undefined) {
            delete process.env["PI_CODING_AGENT_DIR"];
        } else {
            process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
        }

        rmSync(root, { recursive: true, force: true });
    });

    const runtime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    const faux = fauxProvider({
        provider: "faux",
        models: [
            { id: "faux-1", reasoning: true },
            { id: "faux-2", reasoning: true },
        ],
    });

    runtime.registerNativeProvider(faux.provider);

    const first = runtime.getModel("faux", "faux-1")!;
    const second = runtime.getModel("faux", "faux-2")!;
    const parent = SessionManager.create(cwd, join(root, "parent-sessions"));
    const pi = new FakePi(parent);
    const state: FakeCtxState = {
        hasUI: true,
        model: first as Model<string>,
        scopedModels: [],
        thinkingLevel: "medium",
        projectTrusted: true,
        idle: true,
        aborted: false,
        selectAnswer: undefined,
        selectCalls: [],
        notifications: [],
    };
    const ctx = createFakeContext({ cwd, parent, runtime, state });

    return {
        root,
        agentDir,
        cwd,
        parent,
        pi,
        runtime,
        faux,
        models: { first: first as Model<string>, second: second as Model<string> },
        state,
        ctx,
        createManager(
            definitions = [],
            managerCtx = ctx,
            extensionTools,
            autoModelSettings,
            modelSelection,
        ) {
            const manager = new RunManager({
                pi: pi.asApi(),
                ctx: managerCtx,
                agentDir,
                definitions,
                extensionTools,
                autoModelSettings,
                modelSelection,
                modelRuntime: runtime,
            });

            managers.push(manager);

            return manager;
        },
    };
}

function createFakeContext(options: {
    cwd: string;
    parent: SessionManager;
    runtime: ModelRuntime;
    state: FakeCtxState;
}): ExtensionContext {
    const { state } = options;

    return {
        get hasUI() {
            return state.hasUI;
        },
        get model() {
            return state.model;
        },
        get scopedModels() {
            return state.scopedModels;
        },
        get thinkingLevel() {
            return state.thinkingLevel;
        },
        isProjectTrusted: () => state.projectTrusted,
        mode: "tui",
        isIdle: () => state.idle,
        get signal() {
            return state.aborted ? AbortSignal.abort() : undefined;
        },
        cwd: options.cwd,
        sessionManager: options.parent,
        modelRegistry: {
            getAvailable: () => [
                options.runtime.getModel("faux", "faux-1"),
                options.runtime.getModel("faux", "faux-2"),
            ],
        },
        ui: {
            theme: createFakeTheme(),
            async select(title: string, choices: string[]) {
                state.selectCalls.push({ title, options: choices });

                return state.selectAnswer;
            },
            notify(message: string, type?: string) {
                state.notifications.push({ message, type });
            },
        },
    } as unknown as ExtensionContext;
}

// Scripted model responses

export function reportResponse(
    status: ReportStatus,
    summary: string,
    extra: { reason?: string; question?: string } = {},
): AssistantMessage {
    return fauxAssistantMessage(fauxToolCall("report", { status, summary, ...extra }), {
        stopReason: "toolUse",
    });
}

export function textResponse(text: string): AssistantMessage {
    return fauxAssistantMessage(text);
}

export function errorResponse(errorMessage: string): AssistantMessage {
    return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

/**
 * A response that waits for `gate`, then reports `done`. An abort ends it at once, as a real
 * provider ends a request, so `stop` does not wait for the gate.
 */
export function gatedResponse(
    gate: Gate,
    onReached?: () => void,
    then: AssistantMessage = reportResponse("done", "finished"),
): FauxResponseFactory {
    return async (_context, streamOptions) => {
        onReached?.();

        const signal = streamOptions?.signal;
        const aborted = new Promise<"aborted">((resolve) => {
            if (signal?.aborted) {
                resolve("aborted");
            }

            signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
        const outcome = await Promise.race([gate.opened.then(() => "open" as const), aborted]);

        return outcome === "aborted" ? fauxAssistantMessage("", { stopReason: "aborted" }) : then;
    };
}

// Waiting on runs

/** Resolves once `run` has ended at least `turns` turns and is not running. */
export function waitForTurns(manager: RunManager, run: Run, turns: number): Promise<void> {
    const done = () => run.turns >= turns && run.state !== "running";

    return within(
        new Promise<void>((resolve) => {
            if (done()) {
                resolve();
                return;
            }

            const unsubscribe = manager.subscribe(() => {
                if (done()) {
                    unsubscribe();
                    resolve();
                }
            });
        }),
        `run ${run.id} to end turn ${turns} (state ${run.state}, turns ${run.turns})`,
    );
}

/** Resolves once `run` is in `state`. */
export function waitForState(manager: RunManager, run: Run, state: Run["state"]): Promise<void> {
    return within(
        new Promise<void>((resolve) => {
            if (run.state === state) {
                resolve();
                return;
            }

            const unsubscribe = manager.subscribe(() => {
                if (run.state === state) {
                    unsubscribe();
                    resolve();
                }
            });
        }),
        `run ${run.id} to become ${state} (is ${run.state})`,
    );
}

/** The run's live session. `live` is private; tests read it to inspect the real tool set. */
export function liveSessionOf(run: Run): LiveSession {
    const live = (run as unknown as { live?: LiveSession }).live;

    if (!live) {
        throw new Error(`Run ${run.id} has no live session.`);
    }

    return live;
}

export function treeEvent(options: {
    oldLeafId: string | null;
    commonAncestorId: string | null;
}): SessionBeforeTreeEvent {
    return {
        type: "session_before_tree",
        preparation: {
            targetId: "target",
            oldLeafId: options.oldLeafId,
            commonAncestorId: options.commonAncestorId,
            entriesToSummarize: [],
            userWantsSummary: false,
        },
        signal: new AbortController().signal,
    } as unknown as SessionBeforeTreeEvent;
}

export function definition(partial: Partial<AgentDefinition> & { name: string }): AgentDefinition {
    return {
        description: `The ${partial.name} agent.`,
        body: "",
        file: `/agents/${partial.name}.md`,
        scope: "user",
        ...partial,
    };
}

/** Starts a run whose first turn waits at the model until the gate opens. */
export async function startGated(
    fx: Fixture,
    manager: RunManager,
    params: Parameters<RunManager["start"]>[0] = { task: "work" },
    then?: AssistantMessage,
): Promise<{ run: Run; gate: Gate }> {
    const gate = createGate();
    const reached = createGate();

    fx.faux.setResponses([gatedResponse(gate, reached.open, then)]);

    const run = await manager.start(params, fx.ctx);

    await within(reached.opened, `run ${run.id} to reach the model`);

    return { run, gate };
}

export function readJsonl(file: string): Array<Record<string, unknown>> {
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}
