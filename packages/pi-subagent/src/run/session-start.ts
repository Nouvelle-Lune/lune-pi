import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
    AgentSession,
    AgentSessionEvent,
    ModelRuntime,
    SessionManager,
    Theme,
} from "@earendil-works/pi-coding-agent";

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
    reason: "startup" | "resume";
    theme: Theme;
    /** Called once the model resolved, so a failed resolution leaves no run file behind. */
    openSessionManager: () => SessionManager;
    sink: SessionSink;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
}

/** Create a run's session, start its built-ins, and check its tools; the session is closed on failure. */
export async function startRunSession(options: StartSessionOptions): Promise<LiveSession> {
    options.onProgress?.("Preparing the run session");

    const services = await createRunServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        projectTrusted: options.projectTrusted,
        appendSystemPrompt: options.appendSystemPrompt,
        modelRuntime: options.modelRuntime,
    });

    for (const diagnostic of services.diagnostics) {
        options.sink.diagnostic({ ...diagnostic, level: diagnostic.type, at: Date.now() });
    }

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
        const check =
            options.check === "default"
                ? (services.settingsManager.getDefaultTools() ?? [])
                : options.check;

        await checkTools(live.session, check, options);
    } catch (error) {
        await live.close();
        throw error;
    }

    return live;
}

/**
 * Every selected tool must exist in the run itself; a missing one fails the start rather than
 * being dropped. MCP tools register only once their server connects, so they are waited for.
 */
async function checkTools(
    session: AgentSession,
    names: readonly string[],
    options: StartSessionOptions,
): Promise<void> {
    const registered = (): Set<string> => new Set(session.getAllTools().map((tool) => tool.name));
    const missing = names.filter((name) => name !== REPORT_TOOL_NAME && !registered().has(name));
    const other = missing.filter((name) => !name.startsWith("mcp__"));

    if (other.length > 0) {
        throw new Error(
            `Not available in a run: ${other.join(", ")}. Runs have Pi's native tools, codemode, ` +
                "tool_search and the MCP tools of the run's configured servers.",
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
