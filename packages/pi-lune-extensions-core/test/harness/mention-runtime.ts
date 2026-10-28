import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    ModelRuntime,
    SettingsManager as PiSettingsManager,
    type AgentSessionRuntime,
    type CreateAgentSessionRuntimeFactory,
    type ExtensionError,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installMentions } from "../../src/mention/index.ts";
import { scopedExtension } from "../../src/resources/index.ts";

export interface MentionNotice {
    message: string;
    type: string;
}

/** UI and error state captured by one session binding, as a real TUI host provides them. */
export interface MentionBinding {
    notices: MentionNotice[];
    errors: ExtensionError[];
    /** Settles with the first notice this binding receives. */
    firstNotice: Promise<MentionNotice>;
}

export interface MentionRuntimeOptions {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
}

export interface MentionHost {
    runtime: AgentSessionRuntime;
    bindings: MentionBinding[];
    dispose(): Promise<void>;
}

/**
 * A real Pi runtime whose extension is Core's production mention wiring
 * (scopedExtension owns installMentions and disposes it on session_shutdown).
 */
export async function createMentionHost(options: MentionRuntimeOptions): Promise<MentionHost> {
    const model = fauxProvider({
        provider: "lune-mention-lifecycle",
        models: [{ id: "session-model", contextWindow: 128_000, maxTokens: 8_192 }],
    });
    const modelRuntime = await ModelRuntime.create({
        authPath: join(options.agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(model.provider);
    const settingsManager = PiSettingsManager.inMemory({ retry: { enabled: false } });
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
    }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoaderOptions: {
                extensionFactories: [
                    scopedExtension((pi, resources) => installMentions(pi, resources)),
                ],
                noContextFiles: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
            },
        });
        return {
            ...(await createAgentSessionFromServices({
                services,
                sessionManager,
                sessionStartEvent,
                model: model.getModel(),
                tools: [],
            })),
            services,
            diagnostics: services.diagnostics,
        };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, options);
    const bindings: MentionBinding[] = [];
    // A fresh UI binding per session, like a real host rebind after replacement.
    const bind = async () => {
        let resolveFirstNotice!: (notice: MentionNotice) => void;
        const firstNotice = new Promise<MentionNotice>((resolve) => {
            resolveFirstNotice = resolve;
        });
        const binding: MentionBinding = {
            notices: [],
            errors: [],
            firstNotice,
        };
        bindings.push(binding);
        await runtime.session.bindExtensions({
            mode: "tui",
            // The harness only provides the UI calls that session_start and mention input use.
            uiContext: {
                notify: (message: string, type: string) => {
                    const notice = { message, type };
                    binding.notices.push(notice);
                    resolveFirstNotice(notice);
                },
                addAutocompleteProvider: () => () => undefined,
                setEditorText: () => undefined,
            } as never,
            onError: (error: ExtensionError) => binding.errors.push(error),
        });
    };
    runtime.setRebindSession(bind);
    await bind();

    let disposed = false;
    return {
        runtime,
        bindings,
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            await runtime.dispose();
        },
    };
}
