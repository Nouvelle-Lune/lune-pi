import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
    SettingsManager,
    type AgentSession,
    type AgentSessionEvent,
    type AgentSessionServices,
    type ModelRuntime,
    type SessionManager,
    type Theme,
} from "@earendil-works/pi-coding-agent";

import { isSyntheticPath, type ExtensionTool } from "../extension-tools.ts";
import type { ModelRef } from "../models.ts";
import { createReportTool, REPORT_TOOL_NAME } from "./report-tool.ts";
import {
    createRunServices,
    openLiveSession,
    resolveRunModel,
    type Diagnostic,
    type LiveSession,
} from "./run-session.ts";
import type { RunReport } from "./types.ts";

/** How long `subagent_start` waits for a selected MCP tool to register. */
const MCP_DISCOVERY_TIMEOUT_MS = 30_000;
const MCP_POLL_INTERVAL_MS = 200;

export interface RunEventTarget {
    handleEvent(event: AgentSessionEvent): void;
    addDiagnostic(diagnostic: Diagnostic): void;
    recordReport(report: RunReport): void;
}

/**
 * Routes a session's events to its run. A new run's session starts, and is checked, before the run
 * exists, so diagnostics from that phase are kept and handed over on attach.
 */
export class SessionSink {
    private target: RunEventTarget | undefined;
    private pending: Diagnostic[] = [];
    /** Every diagnostic so far; startup checks read it while they wait. */
    readonly seen: Diagnostic[] = [];

    attach(target: RunEventTarget): void {
        this.target = target;

        for (const diagnostic of this.pending.splice(0)) {
            target.addDiagnostic(diagnostic);
        }
    }

    event(event: AgentSessionEvent): void {
        this.target?.handleEvent(event);
    }

    diagnostic(diagnostic: Diagnostic): void {
        this.seen.push(diagnostic);

        if (this.target) {
            this.target.addDiagnostic(diagnostic);
        } else {
            this.pending.push(diagnostic);
        }
    }

    report(report: RunReport): void {
        this.target?.recordReport(report);
    }
}

export interface StartSessionOptions {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
    appendSystemPrompt: readonly string[];
    modelRuntime?: ModelRuntime;
    model: ModelRef;
    thinkingLevel: ThinkingLevel | undefined;
    /** The SDK `tools` option: an allowlist with `report`, or `["+report"]` for the default selection. */
    tools: string[];
    /** Task tools that must exist once the session runs; "default" checks the defaultTools setting. */
    check: readonly string[] | "default";
    /** The parent's extension tools; the run loads the extensions of those that `check` names. */
    extensionTools: readonly ExtensionTool[];
    reason: "startup" | "resume";
    theme: Theme;
    /** Called once the model resolved, so a failed resolution leaves no run file behind. */
    openSessionManager: () => SessionManager;
    sink: SessionSink;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
}

/** Create a run's session, start its extensions, and check its tools; the session is closed on failure. */
export async function startRunSession(options: StartSessionOptions): Promise<LiveSession> {
    options.onProgress?.("Preparing the run session");

    // The services load the extensions of the selected tools, so the default selection is read
    // from the run's own settings before they exist.
    const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
        projectTrusted: options.projectTrusted,
    });
    const check =
        options.check === "default" ? (settingsManager.getDefaultTools() ?? []) : options.check;
    const extensionTools = options.extensionTools.filter((tool) => check.includes(tool.name));
    const services = await createRunServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        projectTrusted: options.projectTrusted,
        appendSystemPrompt: options.appendSystemPrompt,
        modelRuntime: options.modelRuntime,
        settingsManager,
        extensionTools,
    });

    for (const diagnostic of services.diagnostics) {
        options.sink.diagnostic({ ...diagnostic, level: diagnostic.type, at: Date.now() });
    }

    checkExtensionsLoaded(services, extensionTools, options.sink);

    const model = await resolveRunModel(services, options.model.provider, options.model.id);
    const sessionManager = options.openSessionManager();
    const live = await openLiveSession({
        services,
        sessionManager,
        model,
        thinkingLevel: options.thinkingLevel,
        tools: options.tools,
        customTools: [createReportTool((report) => options.sink.report(report))],
        reason: options.reason,
        theme: options.theme,
        onEvent: (event) => options.sink.event(event),
        onDiagnostic: (diagnostic) => options.sink.diagnostic(diagnostic),
    });

    try {
        await checkTools(live.session, check, extensionTools, options);
    } catch (error) {
        await live.close();
        throw error;
    }

    return live;
}

/**
 * An extension of a selected tool that fails to load fails the start. With `noExtensions`, every
 * load error with a file path belongs to one of them; the built-ins report theirs at session start.
 */
function checkExtensionsLoaded(
    services: AgentSessionServices,
    extensionTools: readonly ExtensionTool[],
    sink: SessionSink,
): void {
    if (extensionTools.length === 0) {
        return;
    }

    const errors = services.resourceLoader
        .getExtensions()
        .errors.filter((error) => !isSyntheticPath(error.path));

    if (errors.length > 0) {
        throw new Error(
            "The extensions of the run's tools failed to load:\n" +
                errors.map((error) => `${error.path}: ${error.error}`).join("\n"),
        );
    }

    const byPath = new Map<string, string[]>();

    for (const tool of extensionTools) {
        byPath.set(tool.path, [...(byPath.get(tool.path) ?? []), tool.name]);
    }

    for (const [path, names] of byPath) {
        sink.diagnostic({
            level: "info",
            message: `Loaded the extension ${path} for ${names.join(", ")}.`,
            at: Date.now(),
        });
    }
}

/**
 * Every selected tool must exist in the run itself; a missing one fails the start rather than
 * being dropped. MCP tools register only once their server connects, so they are waited for.
 */
async function checkTools(
    session: AgentSession,
    names: readonly string[],
    extensionTools: readonly ExtensionTool[],
    options: StartSessionOptions,
): Promise<void> {
    const registered = (): Set<string> => new Set(session.getAllTools().map((tool) => tool.name));
    const missing = names.filter((name) => name !== REPORT_TOOL_NAME && !registered().has(name));
    // An extension can register a tool depending on its working directory or settings.
    const unregistered = extensionTools.filter((tool) => missing.includes(tool.name));

    if (unregistered.length > 0) {
        throw new Error(
            unregistered
                .map(
                    (tool) =>
                        `The extension ${tool.path} did not register ${tool.name} in the run.`,
                )
                .join("\n"),
        );
    }

    const other = missing.filter((name) => !name.startsWith("mcp__"));

    if (other.length > 0) {
        throw new Error(
            `Not available in a run: ${other.join(", ")}. Runs have Pi's native tools, codemode, ` +
                "tool_search, the MCP tools of the run's configured servers and the tools of your " +
                "extensions, except the subagent tools.",
        );
    }

    if (missing.length === 0) {
        return;
    }

    options.onProgress?.(`Waiting for MCP tools: ${missing.join(", ")}`);

    const deadline = Date.now() + MCP_DISCOVERY_TIMEOUT_MS;
    let checked = 0;

    for (;;) {
        const tools = registered();
        const waiting = missing.filter((name) => !tools.has(name));

        if (waiting.length === 0) {
            return;
        }

        // A connected server registers all of its tools together, so a namespace that has tools
        // but not this one means the server does not offer it.
        const namespaces = session
            .getAllTools()
            .flatMap((tool) => (tool.namespace ? [tool.namespace] : []));
        const absent = waiting.filter((name) =>
            namespaces.some((namespace) => name.startsWith(`${namespace}__`)),
        );

        if (absent.length > 0) {
            throw new Error(`The run's MCP servers do not offer: ${absent.join(", ")}.`);
        }

        const failures = options.sink.seen
            .slice(checked)
            .filter((diagnostic) =>
                /^MCP (servers need attention|failed to load)/.test(diagnostic.message),
            );

        checked = options.sink.seen.length;

        if (failures.length > 0) {
            throw new Error(
                `MCP tools ${waiting.join(", ")} are not available: ` +
                    failures.map((diagnostic) => diagnostic.message).join("\n"),
            );
        }

        if (options.signal?.aborted) {
            throw new Error("Cancelled while waiting for MCP tools.");
        }

        if (Date.now() >= deadline) {
            const recent = options.sink.seen.map((diagnostic) => diagnostic.message);

            throw new Error(
                `MCP tools ${waiting.join(", ")} did not register within ` +
                    `${MCP_DISCOVERY_TIMEOUT_MS / 1000} s.` +
                    (recent.length > 0 ? ` Run diagnostics:\n${recent.join("\n")}` : ""),
            );
        }

        await new Promise((resolve) => setTimeout(resolve, MCP_POLL_INTERVAL_MS));
    }
}
