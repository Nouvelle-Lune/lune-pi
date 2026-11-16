import {
    defineTool,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolAnnotations,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";

import { MemoryClient, type MemoryClientOptions } from "./client/memory-client.ts";
import { loadConfig } from "./core/config.ts";
import { MEMORY_CONTEXT_TAG } from "./core/types.ts";
import { errorMessage } from "./core/util.ts";
import { callMcpTool, MCP_TOOLS, type McpToolName } from "./integrations/mcp.ts";

/** Time that the first turn waits for L1. A slower answer leaves L1 out of that turn. */
const L1_WAIT_MS = 10_000;

/** Arguments that the Pi tools fill in from the session, so the agent does not give them. */
const SESSION_ARGUMENTS = new Set(["session_id", "cwd"]);

const TOOL_LABELS: Record<McpToolName, string> = {
    transcript_search: "Memory Search",
    note_write: "Memory Note",
    note_update: "Memory Note Update",
    note_retract: "Memory Note Retract",
    memory_location: "Memory Location",
};

const TOOL_SNIPPETS: Record<McpToolName, string> = {
    transcript_search: "Search the transcripts of earlier sessions.",
    note_write: "Save a durable fact, decision or lesson to memory.",
    note_update: "Change a note that this session wrote.",
    note_retract: "Withdraw a note that this session wrote.",
    memory_location: "Show where the memory files are.",
};

interface JsonSchemaObject {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
}

/** The MCP input schema without the arguments that the session gives. */
export function piToolSchema(schema: JsonSchemaObject): JsonSchemaObject {
    const properties = Object.fromEntries(
        Object.entries(schema.properties).filter(([key]) => !SESSION_ARGUMENTS.has(key)),
    );
    const required = schema.required?.filter((key) => !SESSION_ARGUMENTS.has(key));
    return {
        ...schema,
        properties,
        ...(required ? { required } : {}),
    };
}

/** L1 text without the wrapper tag. Pi wraps each prompt section in a tag of its key. */
export function l1SectionText(text: string): string {
    const open = `<${MEMORY_CONTEXT_TAG}>`;
    const close = `</${MEMORY_CONTEXT_TAG}>`;
    let body = text.trim();
    if (body.startsWith(open)) body = body.slice(open.length);
    if (body.endsWith(close)) body = body.slice(0, -close.length);
    return body.trim();
}

/** MCP annotations without the title, which Pi takes from the label. */
function toolHints(annotations: ToolAnnotations & { title?: string }): ToolAnnotations {
    const { title: _title, ...hints } = annotations;
    return hints;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface PiExtensionOptions extends MemoryClientOptions {
    /** Backend for tests. The default is a MemoryClient of the daemon. */
    client?: MemoryClient;
}

/** Tools of the Pi extension. They call the same code as the MCP server. */
export function createMemoryTools(client: MemoryClient): ToolDefinition[] {
    return MCP_TOOLS.map((tool) =>
        defineTool({
            name: tool.name,
            label: TOOL_LABELS[tool.name],
            description: tool.description,
            promptSnippet: TOOL_SNIPPETS[tool.name],
            parameters: Type.Unsafe<Record<string, unknown>>(
                piToolSchema(tool.inputSchema as JsonSchemaObject),
            ),
            annotations: toolHints(tool.annotations),
            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                const result = await callMcpTool(
                    {
                        backend: client,
                        harness: "pi",
                        sessionId: ctx.sessionManager.getSessionId() ?? null,
                        cwd: ctx.cwd,
                    },
                    tool.name,
                    params,
                );
                return { content: result.content, details: undefined, isError: result.isError };
            },
        }),
    );
}

/**
 * Pi extension of lune-memory. It puts L1 into the system prompt as a section and adds the memory
 * tools. A failure never blocks the session: the extension warns one time and goes on without L1.
 */
export function createPiExtension(options: PiExtensionOptions = {}): (pi: ExtensionAPI) => void {
    return (pi) => {
        const { client: given, ...clientOptions } = options;
        const client = given ?? new MemoryClient(clientOptions);
        let section: string | undefined;
        let pending: Promise<void> | undefined;
        // Number of the latest L1 request. An older answer that arrives later is dropped.
        let request = 0;
        let warned = false;
        let hinted = false;

        const warn = (ctx: ExtensionContext, message: string): void => {
            if (warned) return;
            warned = true;
            ctx.ui.notify(`lune-memory: ${message}`, "warning");
        };

        const refresh = (ctx: ExtensionContext): void => {
            const sessionId = ctx.sessionManager.getSessionId() ?? null;
            const id = ++request;
            pending = client
                .l1({ cwd: ctx.cwd, harness: "pi", sessionId, announceSession: false })
                .then((result) => {
                    if (id === request) section = l1SectionText(result.text);
                })
                .catch((error: unknown) => {
                    if (id !== request) return;
                    warn(ctx, `memory context is not available (${errorMessage(error)}).`);
                });
        };

        for (const tool of createMemoryTools(client)) pi.registerTool(tool);

        pi.on("session_start", (_event, ctx) => {
            section = undefined;
            refresh(ctx);
            if (hinted) return;
            hinted = true;
            try {
                if (!loadConfig(client.paths.config).harnesses.pi.enabled) {
                    ctx.ui.notify(
                        "lune-memory: Pi sessions are not imported. Run `lune-memory setup pi` to add them to memory.",
                        "info",
                    );
                }
            } catch (error) {
                warn(ctx, `the config is not readable (${errorMessage(error)}).`);
            }
        });

        // A compaction drops the prompt cache, so it is the time to read L1 again.
        pi.on("session_compact", (_event, ctx) => {
            refresh(ctx);
        });

        pi.on("before_agent_start", async (event) => {
            const waiting = pending;
            if (waiting) {
                await withTimeout(waiting, L1_WAIT_MS);
                // A refresh that started during the wait keeps its own promise.
                if (pending === waiting) pending = undefined;
            }
            // The same text on every turn, so Pi's section diff sends no patch and the cache holds.
            if (section) event.systemPromptOptions.sections[MEMORY_CONTEXT_TAG] = section;
        });

        pi.on("session_shutdown", async () => {
            request++;
            section = undefined;
            pending = undefined;
            await client.close();
        });
    };
}

export default createPiExtension();
