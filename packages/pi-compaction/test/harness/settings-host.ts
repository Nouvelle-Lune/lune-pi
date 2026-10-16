import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager as PiSettingsManager,
    type AgentSession,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acquireSettings, type SettingsLease } from "@lune_99/pi-lune-extensions-core/settings/advanced";
import {
    compactionSchema,
    SETTINGS_ID,
    type CompactionSettings,
    type CompactionSettingsView,
} from "../../src/settings/schema.ts";
import { compactionSettings } from "../../src/settings/section.ts";
import { installConfiguredCompaction } from "../../src/extension.ts";

export interface TemporaryPiEnvironment {
    readonly root: string;
    readonly agentDir: string;
    readonly cwd: string;
    settingsPath(scope: "global" | "project"): string;
    cleanup(): void;
}

export function createTemporaryPiEnvironment(prefix: string): TemporaryPiEnvironment {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousCwd = process.cwd();
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(cwd);
    let cleaned = false;
    return {
        root,
        agentDir,
        cwd,
        settingsPath: (scope) =>
            scope === "global"
                ? join(agentDir, "lune-settings", `${SETTINGS_ID}.json`)
                : join(cwd, ".pi", "lune-settings", `${SETTINGS_ID}.json`),
        cleanup() {
            if (cleaned) return;
            cleaned = true;
            process.chdir(previousCwd);
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

export async function withTemporaryPiEnvironment<T>(
    prefix: string,
    run: (environment: TemporaryPiEnvironment) => Promise<T>,
): Promise<T> {
    const environment = createTemporaryPiEnvironment(prefix);
    try {
        return await run(environment);
    } finally {
        environment.cleanup();
    }
}

export async function acquireCompactionSettings(
    cwd: string,
): Promise<SettingsLease<typeof compactionSchema>> {
    return acquireSettings(compactionSettings, { cwd, projectTrusted: true });
}

export async function withCompactionSettings<T>(
    prefix: string,
    run: (settings: CompactionSettingsView, environment: TemporaryPiEnvironment) => Promise<T>,
): Promise<T> {
    return withTemporaryPiEnvironment(prefix, async (environment) => {
        const lease = await acquireCompactionSettings(environment.cwd);
        try {
            return await run(lease.settings, environment);
        } finally {
            await lease.release();
        }
    });
}

export async function seedCompactionSettings(
    cwd: string,
    settings: Partial<CompactionSettings>,
): Promise<void> {
    const lease = await acquireCompactionSettings(cwd);
    try {
        const view = lease.settings;
        for (const [key, value] of Object.entries(settings) as Array<
            [keyof CompactionSettings, CompactionSettings[keyof CompactionSettings]]
        >) {
            await view.set(key, value as never, { scope: "global" });
        }
    } finally {
        await lease.release();
    }
}

export interface SettingsHostOptions {
    readonly savedSettings?: Partial<CompactionSettings>;
    readonly summaryReasoning?: boolean;
    readonly mode?: "print" | "tui";
    readonly history: import("@earendil-works/pi-agent-core").AgentMessage[];
}

export interface SettingsHost {
    readonly session: AgentSession;
    readonly sessionManager: SessionManager;
    readonly main: FauxProviderHandle;
    readonly summary: FauxProviderHandle;
    readonly context: () => ExtensionContext;
    readonly integration: Awaited<ReturnType<typeof installConfiguredCompaction>>;
    readonly environment: TemporaryPiEnvironment;
    shutdown(): Promise<void>;
    dispose(): Promise<void>;
}

export async function startSettingsHost(options: SettingsHostOptions): Promise<SettingsHost> {
    const environment = createTemporaryPiEnvironment("lune-settings-host-");
    let session: AgentSession | undefined;
    let integration: Awaited<ReturnType<typeof installConfiguredCompaction>> | undefined;
    let disposed = false;
    const shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    try {
        if (options.savedSettings) {
            await seedCompactionSettings(environment.cwd, options.savedSettings);
        }

        const main = fauxProvider({
            provider: "lune-settings-main",
            models: [{ id: "main-model", contextWindow: 128_000, maxTokens: 8_192 }],
        });
        const summary = fauxProvider({
            provider: "lune-settings-summary",
            models: [
                {
                    id: "selected-summary",
                    reasoning: options.summaryReasoning ?? true,
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                },
                { id: "other-summary", reasoning: true, contextWindow: 128_000, maxTokens: 8_192 },
            ],
        });
        const modelRuntime = await ModelRuntime.create({
            authPath: join(environment.agentDir, "auth.json"),
            modelsPath: null,
            refreshOnCreate: false,
        });
        modelRuntime.registerNativeProvider(main.provider);
        modelRuntime.registerNativeProvider(summary.provider);

        const sessionManager = SessionManager.inMemory(environment.cwd);
        for (const message of options.history) sessionManager.appendMessage(message as never);
        const piSettings = PiSettingsManager.inMemory({
            compaction: { keepRecentTokens: 100 },
            retry: { enabled: false },
        });
        let context: ExtensionContext | undefined;
        const uiContext = { notify: () => undefined };
        const resourceLoader = new DefaultResourceLoader({
            cwd: environment.cwd,
            agentDir: environment.agentDir,
            settingsManager: piSettings,
            noContextFiles: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            extensionFactories: [
                async (pi) => {
                    pi.on("session_start", (_event, ctx) => {
                        context = ctx;
                    });
                },
                async (pi) => {
                    const instrumented = new Proxy(pi, {
                        get(target, property, receiver) {
                            if (property === "on") {
                                return (event: string, handler: (...args: never[]) => unknown) => {
                                    if (event === "session_shutdown") {
                                        shutdownHandlers.push(handler as never);
                                    }
                                    return target.on(event as never, handler as never);
                                };
                            }
                            return Reflect.get(target, property, receiver);
                        },
                    }) as ExtensionAPI;
                    integration = await installConfiguredCompaction(instrumented);
                },
            ],
        });
        await resourceLoader.reload();
        const created = await createAgentSession({
            cwd: environment.cwd,
            agentDir: environment.agentDir,
            modelRuntime,
            model: main.getModel(),
            sessionManager,
            settingsManager: piSettings,
            resourceLoader,
            tools: [],
        });
        session = created.session;
        await session.bindExtensions({
            mode: options.mode ?? "print",
            uiContext: uiContext as never,
        });
        if (!context) throw new Error("Settings host did not observe session_start");
        if (!integration) throw new Error("Settings host did not install compaction integration");

        let shutdown = false;
        const runShutdown = async (): Promise<void> => {
            if (shutdown) return;
            shutdown = true;
            const errors: unknown[] = [];
            for (const handler of shutdownHandlers) {
                try {
                    await handler({ type: "session_shutdown", reason: "quit" }, context!);
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length) throw new AggregateError(errors, "Settings host shutdown failed");
        };

        return {
            session,
            sessionManager,
            main,
            summary,
            context: () => context!,
            integration,
            environment,
            shutdown: runShutdown,
            async dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    await runShutdown();
                } finally {
                    try {
                        await integration!.dispose();
                    } finally {
                        session!.dispose();
                        environment.cleanup();
                    }
                }
            },
        };
    } catch (error) {
        try {
            await integration?.dispose();
        } finally {
            session?.dispose();
            environment.cleanup();
        }
        throw error;
    }
}

export function userMessage(text: string): import("@earendil-works/pi-agent-core").AgentMessage {
    return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantMessage(
    text: string,
): import("@earendil-works/pi-agent-core").AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "lune-settings-main",
        model: "main-model",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

export function seedSuccessfulResponses(host: SettingsHost): void {
    host.main.setResponses([fauxAssistantMessage("native Pi summary")]);
    host.summary.setResponses([
        (_context, _options, _state, model) => fauxAssistantMessage(`summary from ${model.id}`),
    ]);
}
