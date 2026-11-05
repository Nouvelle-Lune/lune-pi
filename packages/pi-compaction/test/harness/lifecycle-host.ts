import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    createAssistantMessageEventStream,
    fauxProvider,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type FauxProviderHandle,
    type Model,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installCompaction } from "../../src/index.ts";
import type { CompactionController } from "../../src/compaction-controller.ts";
import type { ConfigurationProvider } from "../../src/options.ts";

export interface FauxModelSpec {
    id: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
}

/** A model registry face backed by test-supplied models and a test-controlled stream. */
export interface PlainModelRegistry {
    models: Model<string>[];
    streamSimple: (
        model: Model<string>,
        context: unknown,
        options:
            | {
                  signal?: AbortSignal;
                  maxTokens?: number;
                  reasoning?: unknown;
                  [key: string]: unknown;
              }
            | undefined,
    ) => AssistantMessageEventStream;
}

export interface ControllerHarnessOptions {
    configuration: ConfigurationProvider;
    registry: PlainModelRegistry;
    tools?: unknown[];
    sessionId?: string;
    leafId?: string | null;
}

export interface ControllerHarness {
    pi: ExtensionAPI;
    controller: CompactionController;
    ctx: ExtensionContext;
    /** Mutable session identity so tests can change the leaf mid-operation. */
    session: { sessionId: string; leafId: string | null };
    /** Invoke every handler the controller registered for a lifecycle event. */
    emit: (event: string, ...args: unknown[]) => Promise<void>;
}

/**
 * Plain controller harness: captures the handlers installed through `pi.on` so lifecycle
 * events can be raised without a full Pi host, while keeping the production hook wiring.
 */
export function createControllerHarness(options: ControllerHarnessOptions): ControllerHarness {
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
    const pi = {
        on: (event: string, handler: (...args: never[]) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
            return () => {
                const current = handlers.get(event);
                if (current)
                    handlers.set(
                        event,
                        current.filter((entry) => entry !== handler),
                    );
            };
        },
        getAllTools: () => options.tools ?? [],
        registerEntryRenderer: () => undefined,
        appendEntry: () => undefined,
    } as unknown as ExtensionAPI;

    const session = {
        sessionId: options.sessionId ?? "session-1",
        leafId: options.leafId ?? "leaf-1",
    };
    const ctx = {
        hasUI: false,
        ui: { notify: () => undefined },
        signal: undefined,
        sessionManager: { getSessionId: () => session.sessionId, getLeafId: () => session.leafId },
        modelRegistry: {
            find: (provider: string, modelId: string) =>
                options.registry.models.find(
                    (model) => model.provider === provider && model.id === modelId,
                ),
            streamSimple: options.registry.streamSimple,
            getAvailable: () => options.registry.models,
        },
        scopedModels: [],
    } as unknown as ExtensionContext;

    const controller = installCompaction(pi, options.configuration);
    return {
        pi,
        controller,
        ctx,
        session,
        emit: async (event: string, ...args: unknown[]) => {
            for (const handler of [...(handlers.get(event) ?? [])])
                await (handler as (...values: unknown[]) => unknown)(...args);
        },
    };
}

/** A stream that never produces a final result, so a hanging provider request can be observed. */
export function hangingStream(): {
    stream: AssistantMessageEventStream;
    resolve: (message: AssistantMessage) => void;
} {
    const stream = createAssistantMessageEventStream();
    return {
        stream,
        resolve: (message: AssistantMessage) => {
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
        },
    };
}

export interface LifecycleHostOptions {
    configuration: ConfigurationProvider;
    history?: AgentMessage[];
    mainModel?: FauxModelSpec;
    summaryModel?: FauxModelSpec;
    settings?: Record<string, unknown>;
    observerFactories?: Array<(pi: ExtensionAPI) => void>;
    tools?: string[];
}

export interface LifecycleHost {
    session: AgentSession;
    controller: CompactionController;
    runtime: ModelRuntime;
    sessionManager: SessionManager;
    main: FauxProviderHandle;
    summary: FauxProviderHandle;
    /** The extension context captured on session_start. */
    context: () => ExtensionContext;
    dispose: () => void;
}

/**
 * Real Pi SDK host over offline faux providers. Isolated from the developer's global config by
 * a temporary auth path and an in-memory model store, and torn down by `dispose`.
 */
export async function startLifecycleHost(options: LifecycleHostOptions): Promise<LifecycleHost> {
    const dir = mkdtempSync(join(tmpdir(), "lune-lifecycle-"));
    const mainModel = options.mainModel ?? {
        id: "main-1",
        contextWindow: 128_000,
        maxTokens: 8_192,
    };
    const summaryModel = options.summaryModel ?? {
        id: "summary-1",
        contextWindow: 200_000,
        maxTokens: 8_192,
    };
    const main = fauxProvider({
        provider: "lune-main",
        models: [
            {
                id: mainModel.id,
                reasoning: mainModel.reasoning ?? false,
                contextWindow: mainModel.contextWindow ?? 128_000,
                maxTokens: mainModel.maxTokens ?? 8_192,
            },
        ],
    });
    const summary = fauxProvider({
        provider: "lune-summary",
        models: [
            {
                id: summaryModel.id,
                reasoning: summaryModel.reasoning ?? false,
                contextWindow: summaryModel.contextWindow ?? 200_000,
                maxTokens: summaryModel.maxTokens ?? 8_192,
            },
        ],
    });

    const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(main.provider);
    runtime.registerNativeProvider(summary.provider);

    const sessionManager = SessionManager.inMemory(dir);
    for (const message of options.history ?? []) sessionManager.appendMessage(message as never);
    const settingsManager = SettingsManager.inMemory({
        compaction: { keepRecentTokens: 100 },
        retry: { enabled: false },
        ...options.settings,
    });

    let controller!: CompactionController;
    let context: ExtensionContext | undefined;
    const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
            (pi) => {
                pi.on("session_start", (_event, ctx) => {
                    context = ctx;
                });
            },
            ...(options.observerFactories ?? []),
            (pi) => {
                controller = installCompaction(pi, options.configuration);
            },
        ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: runtime,
        model: main.getModel(),
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: options.tools ?? [],
    });
    await session.bindExtensions({ mode: "print" });

    return {
        session,
        controller,
        runtime,
        sessionManager,
        main,
        summary,
        context: () => {
            if (!context) throw new Error("host: no extension context after session_start");
            return context;
        },
        dispose: () => {
            session.dispose();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
