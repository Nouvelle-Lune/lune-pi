import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    createAgentSessionFromServices,
    createAgentSessionServices,
    type AgentSession,
    type AgentSessionEvent,
    type AgentSessionServices,
    type ExtensionError,
    type ExtensionUIContext,
    type LoadExtensionsResult,
    type ModelRuntime,
    type RegisteredTool,
    type SessionManager,
    type SettingsManager,
    type Theme,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { runExtensionFactories } from "../catalog.ts";
import { isSyntheticPath, type ExtensionTool } from "../extension-tools.ts";

export interface RunServicesOptions {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
    /** The definition body, if any, then the subagent guide. */
    appendSystemPrompt: readonly string[];
    /** Tests only: a runtime with an offline provider. Runs otherwise create their own. */
    modelRuntime?: ModelRuntime;
    /** The run's settings; created for `cwd` when left out. */
    settingsManager?: SettingsManager;
    /** The extension tools the run selected; it loads their extensions. */
    extensionTools: readonly ExtensionTool[];
}

/**
 * Services for one run's working directory: its settings, resources and its own model runtime.
 *
 * `noExtensions` keeps user and project extensions out, including installed Lune packages. The
 * run loads the three built-in factories and, for each selected extension tool, the file of the
 * extension that registers it, which then registers only the selected tools.
 */
export async function createRunServices(
    options: RunServicesOptions,
): Promise<AgentSessionServices> {
    const selected = new Set(options.extensionTools.map((tool) => tool.name));

    return createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager: options.settingsManager,
        modelRuntime: options.modelRuntime,
        resourceLoaderOptions: {
            noExtensions: true,
            extensionFactories: runExtensionFactories(),
            additionalExtensionPaths: [...new Set(options.extensionTools.map((tool) => tool.path))],
            extensionsOverride: (base) => keepSelectedTools(base, selected),
            // The override takes literal text. `appendSystemPrompt` would read an entry that happens
            // to name an existing file as that file, and it would drop a discovered APPEND_SYSTEM.md.
            appendSystemPromptOverride: (base) => [
                ...base,
                ...options.appendSystemPrompt.filter((text) => text.trim() !== ""),
            ],
        },
        resourceLoaderReloadOptions: {
            resolveProjectTrust: async () => options.projectTrusted,
        },
    });
}

/**
 * With `noExtensions`, the only extensions with a file are those loaded for selected tools. Their
 * tool maps keep only the selected tools, also for tools they register later, so an extension
 * loaded for one tool adds no others and does not replace the run's native tools.
 */
function keepSelectedTools(
    result: LoadExtensionsResult,
    selected: ReadonlySet<string>,
): LoadExtensionsResult {
    for (const extension of result.extensions) {
        if (!isSyntheticPath(extension.path)) {
            extension.tools = new SelectedTools(selected, extension.tools);
        }
    }

    return result;
}

/** A tool map that ignores tools outside the selection; the extension API registers through `set`. */
class SelectedTools extends Map<string, RegisteredTool> {
    private readonly selected: ReadonlySet<string>;

    constructor(selected: ReadonlySet<string>, tools: Iterable<[string, RegisteredTool]>) {
        super();
        this.selected = selected;

        for (const [name, tool] of tools) {
            this.set(name, tool);
        }
    }

    override set(name: string, tool: RegisteredTool): this {
        return this.selected.has(name) ? super.set(name, tool) : this;
    }
}

/** Resolve a model in the run's own runtime and check its auth the way `session.prompt()` does. */
export async function resolveRunModel(
    services: AgentSessionServices,
    provider: string,
    id: string,
): Promise<Model<Api>> {
    const model = services.modelRuntime.getModel(provider, id);

    if (!model) {
        throw new Error(
            `The model ${provider}/${id} is not available to a run. Runs load extensions only ` +
                "for selected tools, so models that an extension provides are missing.",
        );
    }

    const authenticated =
        services.modelRuntime.hasConfiguredAuth(model.provider) ||
        (await services.modelRuntime.checkAuth(model.provider)) !== undefined;

    if (!authenticated) {
        throw new Error(`The model ${provider}/${id} has no configured authentication.`);
    }

    return model;
}

export interface Diagnostic {
    level: "info" | "warning" | "error";
    message: string;
    at: number;
}

export interface LiveSessionOptions {
    services: AgentSessionServices;
    sessionManager: SessionManager;
    model: Model<Api>;
    /** Undefined lets Pi pick the level from the run's settings. */
    thinkingLevel: ThinkingLevel | undefined;
    tools: string[];
    customTools: ToolDefinition[];
    reason: "startup" | "resume";
    theme: Theme;
    onEvent: (event: AgentSessionEvent) => void;
    onDiagnostic: (diagnostic: Diagnostic) => void;
}

export interface LiveSession {
    readonly session: AgentSession;
    /** Idempotent; also the cleanup after a failed initialization. */
    close(): Promise<void>;
}

/**
 * Create the run's SDK session and start its extensions.
 *
 * Events are subscribed before `bindExtensions()`, which emits `session_start` and starts the MCP
 * connections, so nothing the extensions report during startup is missed.
 */
export async function openLiveSession(options: LiveSessionOptions): Promise<LiveSession> {
    const { session } = await createAgentSessionFromServices({
        services: options.services,
        sessionManager: options.sessionManager,
        sessionStartEvent: { type: "session_start", reason: options.reason },
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        tools: options.tools,
        customTools: options.customTools,
    });
    const unsubscribe = session.subscribe(options.onEvent);
    let closing: Promise<void> | undefined;

    const live: LiveSession = {
        session,
        close() {
            closing ??= closeSession(session, unsubscribe, options.onDiagnostic);

            return closing;
        },
    };

    try {
        await session.bindExtensions({
            uiContext: createHeadlessUi(options.theme, options.onDiagnostic),
            onError: (error) => options.onDiagnostic(extensionDiagnostic(error)),
        });
    } catch (error) {
        await live.close();
        throw error;
    }

    return live;
}

/**
 * Abort, then let the extensions shut down, then release the session. `dispose()` alone does not
 * run the MCP shutdown handlers that close server connections.
 */
async function closeSession(
    session: AgentSession,
    unsubscribe: () => void,
    onDiagnostic: (diagnostic: Diagnostic) => void,
): Promise<void> {
    try {
        await session.abort();
    } catch (error) {
        onDiagnostic(errorDiagnostic("Aborting the run failed", error));
    }

    try {
        if (session.extensionRunner.hasHandlers("session_shutdown")) {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
    } catch (error) {
        onDiagnostic(errorDiagnostic("Shutting down the run's extensions failed", error));
    }

    unsubscribe();
    session.dispose();
}

/**
 * The run has no UI. Notifications become run diagnostics, and a dialog that an extension opens is
 * answered as dismissed, with a diagnostic, instead of waiting for a user who cannot see it.
 */
function createHeadlessUi(
    theme: Theme,
    onDiagnostic: (diagnostic: Diagnostic) => void,
): ExtensionUIContext {
    const dismissed = (kind: string, title: string): void => {
        onDiagnostic({
            level: "warning",
            message: `An extension asked for input (${kind}: ${title}), but runs have no UI.`,
            at: Date.now(),
        });
    };

    return {
        async select(title) {
            dismissed("select", title);
            return undefined;
        },
        async confirm(title) {
            dismissed("confirm", title);
            return false;
        },
        async input(title) {
            dismissed("input", title);
            return undefined;
        },
        notify(message, type = "info") {
            onDiagnostic({ level: type, message, at: Date.now() });
        },
        onTerminalInput: () => () => {},
        setStatus() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setWorkingIndicator() {},
        setHiddenThinkingLabel() {},
        setWidget() {},
        setFooter() {},
        setHeader() {},
        setTitle() {},
        async custom() {
            dismissed("custom", "panel");
            return undefined as never;
        },
        pasteToEditor() {},
        setEditorText() {},
        getEditorText: () => "",
        async editor(title) {
            dismissed("editor", title);
            return undefined;
        },
        addAutocompleteProvider() {},
        setEditorComponent() {},
        getEditorComponent: () => undefined,
        theme,
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false, error: "Runs have no UI." }),
        getToolsExpanded: () => false,
        setToolsExpanded() {},
    };
}

function extensionDiagnostic(error: ExtensionError): Diagnostic {
    return {
        level: "error",
        message: `${error.extensionPath} failed in ${error.event}: ${error.error}`,
        at: Date.now(),
    };
}

export function errorDiagnostic(prefix: string, error: unknown): Diagnostic {
    return {
        level: "error",
        message: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
        at: Date.now(),
    };
}
