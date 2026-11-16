import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { SearchRequest } from "../api/requests.ts";
import type { MemoryBackend } from "../client/memory-client.ts";
import {
    HARNESSES,
    isHarness,
    NOTE_KINDS,
    type Harness,
    type ItemKind,
    type SourceRef,
} from "../core/types.ts";
import { errorMessage, packageVersion } from "../core/util.ts";
import type { NoteInput } from "../memory/notes.ts";
import { formatLocation, formatNote, formatSearchResult } from "./format.ts";

/**
 * MCP server over stdio for agents of Claude Code and Codex: newline-delimited JSON-RPC 2.0.
 * It serves note writes, transcript search and the memory folders. It does not deliver L1: the
 * startup hook of each harness does that. Only JSON-RPC goes to the output stream.
 */

/** Protocol versions that this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const INSTRUCTIONS = [
    "Lune Memory keeps the memory of earlier work across Pi, Claude Code and Codex sessions.",
    "Use transcript_search to find earlier sessions, then read the transcript lines of a hit for the detail.",
    "Use note_write to save a durable fact, decision or lesson. Dreaming reviews notes later.",
    "The memory files are a read-only view. Use memory_location to find them.",
].join(" ");

type Json = Record<string, unknown>;

/** A tool argument that is not valid. The agent gets the message and can try again. */
class ArgumentError extends Error {}

function args(value: unknown): Json {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value))
        throw new ArgumentError("arguments must be an object");
    return value as Json;
}

function reqText(input: Json, key: string): string {
    const value = input[key];
    if (typeof value !== "string" || !value.trim())
        throw new ArgumentError(`${key} must be a non-empty string`);
    return value;
}

function optText(input: Json, key: string): string | undefined {
    const value = input[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new ArgumentError(`${key} must be a string`);
    return value;
}

function optFlag(input: Json, key: string): boolean | undefined {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new ArgumentError(`${key} must be true or false`);
    return value;
}

function optInteger(input: Json, key: string, min: number, max: number): number | undefined {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new ArgumentError(`${key} must be an integer from ${min} to ${max}`);
    }
    return value;
}

function optHarnessArg(input: Json, key: string): Harness | undefined {
    const value = optText(input, key);
    if (value === undefined) return undefined;
    if (!isHarness(value)) throw new ArgumentError(`${key} must be one of ${HARNESSES.join(", ")}`);
    return value;
}

function optTime(input: Json, key: string): string | undefined {
    const value = optText(input, key);
    if (value === undefined) return undefined;
    if (Number.isNaN(Date.parse(value)))
        throw new ArgumentError(`${key} must be an ISO date or time`);
    return value;
}

function sourceList(value: unknown): SourceRef[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new ArgumentError("sources must be a list");
    if (value.length > 50) throw new ArgumentError("A note has at most 50 sources");
    return value.map((entry): SourceRef => {
        const source = args(entry);
        const itemId = optText(source, "item_id");
        if (itemId) return { kind: "item", itemId };
        const harness = optHarnessArg(source, "harness");
        if (!harness)
            throw new ArgumentError("A source needs harness, session_id and event_key, or item_id");
        return {
            kind: "event",
            harness,
            sessionId: reqText(source, "session_id"),
            eventKey: reqText(source, "event_key"),
        };
    });
}

// ---------------------------------------------------------------------------------------------
// Tool definitions

const SESSION_ID_ARG = {
    type: "string",
    description:
        "Id of this session, as the memory context states it. Only the session that wrote a note can change it.",
};

const CWD_ARG = {
    type: "string",
    description:
        "Working folder. It selects the project and the branch. Default: the folder of the agent.",
};

export const MCP_TOOLS = [
    {
        name: "transcript_search",
        title: "Search earlier sessions",
        description:
            "Search the transcripts of earlier Pi, Claude Code and Codex sessions. Each hit gives the event, " +
            "the events around it and the transcript line to read. By default the search stays in the project " +
            "of the working folder. A folder outside every project searches all sessions.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description:
                        'Words to find. All words must match. Put a phrase in double quotes: "exact phrase".',
                },
                project: {
                    type: "string",
                    description:
                        "Project id to search. Default: the project of cwd, or all sessions when cwd is in no project.",
                },
                all_projects: {
                    type: "boolean",
                    description: "Search every project and the sessions outside projects.",
                },
                harness: {
                    type: "string",
                    enum: [...HARNESSES],
                    description: "Only sessions of this harness.",
                },
                session: { type: "string", description: "Only events of this session id." },
                since: { type: "string", description: "ISO time. Only events at or after it." },
                until: { type: "string", description: "ISO time. Only events before it." },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 50,
                    description: "Most hits. Default 10.",
                },
                context: {
                    type: "integer",
                    minimum: 0,
                    maximum: 5,
                    description: "Events before and after each hit. Default 1.",
                },
                cwd: CWD_ARG,
            },
            required: ["query"],
            additionalProperties: false,
        },
        annotations: { title: "Search earlier sessions", readOnlyHint: true, openWorldHint: false },
    },
    {
        name: "note_write",
        title: "Write a memory note",
        description:
            "Save a durable fact, decision, lesson or open item for later sessions. The note is provisional " +
            "until Dreaming reviews it. Write what holds and why, not a log of this session.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Short title, at most 200 characters." },
                body: { type: "string", description: "The note, at most 20000 characters." },
                kind: {
                    type: "string",
                    enum: [...NOTE_KINDS],
                    description: "Kind of note. Default note.",
                },
                sources: {
                    type: "array",
                    maxItems: 50,
                    description:
                        "Transcript events or items that support the note, from transcript_search citations.",
                    items: {
                        type: "object",
                        properties: {
                            harness: { type: "string", enum: [...HARNESSES] },
                            session_id: { type: "string" },
                            event_key: { type: "string" },
                            item_id: { type: "string" },
                        },
                        additionalProperties: false,
                    },
                },
                session_id: SESSION_ID_ARG,
                cwd: CWD_ARG,
            },
            required: ["title", "body"],
            additionalProperties: false,
        },
        annotations: {
            title: "Write a memory note",
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
        },
    },
    {
        name: "note_update",
        title: "Update a memory note",
        description:
            "Replace the title and body of a provisional note that this session wrote. A reviewed note does not " +
            "change: write a new note to correct it.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Note id." },
                title: { type: "string", description: "New title." },
                body: { type: "string", description: "New body." },
                session_id: SESSION_ID_ARG,
            },
            required: ["id", "title", "body"],
            additionalProperties: false,
        },
        annotations: {
            title: "Update a memory note",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "note_retract",
        title: "Retract a memory note",
        description:
            "Retire a note that this session wrote, for example when it turned out to be wrong.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Note id." },
                session_id: SESSION_ID_ARG,
            },
            required: ["id"],
            additionalProperties: false,
        },
        annotations: {
            title: "Retract a memory note",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "memory_location",
        title: "Find the memory files",
        description:
            "Give the folders of the read-only memory files: the project index, wiki and notes, the transcripts " +
            "and the global memory.",
        inputSchema: {
            type: "object",
            properties: { cwd: CWD_ARG },
            additionalProperties: false,
        },
        annotations: { title: "Find the memory files", readOnlyHint: true, openWorldHint: false },
    },
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export interface McpToolContext {
    backend: MemoryBackend;
    /** Harness of the agent. It is the writer of the notes. */
    harness: Harness | null;
    /** Session id when the tool arguments do not give one. */
    sessionId: string | null;
    /** Working folder when the tool arguments do not give one. */
    cwd: string;
}

export interface ToolCallResult {
    content: Array<{ type: "text"; text: string }>;
    isError: boolean;
}

function textResult(text: string, isError = false): ToolCallResult {
    return { content: [{ type: "text", text }], isError };
}

/** Run one tool. A rule check or a bad argument gives an error result that the agent reads. */
export async function callMcpTool(
    context: McpToolContext,
    name: string,
    rawArguments: unknown,
): Promise<ToolCallResult> {
    try {
        const input = args(rawArguments);
        const session = optText(input, "session_id") ?? context.sessionId;
        const cwd = optText(input, "cwd") ?? context.cwd;
        switch (name) {
            case "transcript_search": {
                const project = optText(input, "project");
                const harness = optHarnessArg(input, "harness");
                const sessionFilter = optText(input, "session");
                const since = optTime(input, "since");
                const until = optTime(input, "until");
                const limit = optInteger(input, "limit", 1, 50);
                const contextEvents = optInteger(input, "context", 0, 5);
                const allProjects = optFlag(input, "all_projects");
                const request: SearchRequest = {
                    query: reqText(input, "query"),
                    cwd,
                    ...(project ? { projectId: project } : {}),
                    ...(allProjects ? { allProjects } : {}),
                    ...(harness ? { harness } : {}),
                    ...(sessionFilter ? { sessionId: sessionFilter } : {}),
                    ...(since ? { since } : {}),
                    ...(until ? { until } : {}),
                    ...(limit !== undefined ? { limit } : {}),
                    ...(contextEvents !== undefined ? { context: contextEvents } : {}),
                };
                return textResult(formatSearchResult(await context.backend.search(request)));
            }
            case "note_write": {
                const kind = optText(input, "kind");
                if (kind && !NOTE_KINDS.includes(kind as ItemKind)) {
                    throw new ArgumentError(`kind must be one of ${NOTE_KINDS.join(", ")}`);
                }
                const sources = sourceList(input.sources);
                const note: NoteInput = {
                    title: reqText(input, "title"),
                    body: reqText(input, "body"),
                    trust: "inference",
                    cwd,
                    writerHarness: context.harness,
                    writerSession: session,
                    ...(kind ? { kind: kind as ItemKind } : {}),
                    ...(sources ? { sources } : {}),
                };
                const item = await context.backend.noteWrite(note);
                return textResult(`${formatNote(item, "Saved")} Dreaming reviews it later.`);
            }
            case "note_update": {
                const item = await context.backend.noteUpdate(reqText(input, "id"), {
                    title: reqText(input, "title"),
                    body: reqText(input, "body"),
                    harness: context.harness,
                    session,
                });
                return textResult(formatNote(item, "Updated"));
            }
            case "note_retract": {
                const item = await context.backend.noteRetract(reqText(input, "id"), {
                    harness: context.harness,
                    session,
                });
                return textResult(formatNote(item, "Retracted"));
            }
            case "memory_location":
                return textResult(formatLocation(await context.backend.location(cwd)));
            default:
                return textResult(`Unknown tool: ${name}`, true);
        }
    } catch (error) {
        return textResult(errorMessage(error), true);
    }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

function validId(value: unknown): value is JsonRpcId {
    return (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

class RpcError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

export interface McpServerOptions {
    input: Readable;
    output: Writable;
    backend: MemoryBackend;
    harness?: Harness | null;
    sessionId?: string | null;
    cwd?: string;
    /** Diagnostics. They must not go to the output stream. */
    log?: (message: string) => void;
}

/** One MCP connection. It answers each message; a notification gets no answer. */
export class McpConnection {
    private readonly context: McpToolContext;
    private readonly log: (message: string) => void;
    private protocolVersion: string = MCP_PROTOCOL_VERSIONS[0];

    constructor(options: Omit<McpServerOptions, "input" | "output">) {
        this.context = {
            backend: options.backend,
            harness: options.harness ?? null,
            sessionId: options.sessionId ?? null,
            cwd: options.cwd ?? process.cwd(),
        };
        this.log = options.log ?? (() => {});
    }

    /** Answer one line of input. It returns the line to write, or null when no answer is due. */
    async handleLine(line: string): Promise<string | null> {
        if (!line.trim()) return null;
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            return JSON.stringify(failure(null, PARSE_ERROR, "Parse error"));
        }
        if (Array.isArray(message)) {
            if (!message.length)
                return JSON.stringify(failure(null, INVALID_REQUEST, "Empty batch"));
            const answers = await Promise.all(message.map((entry) => this.handleMessage(entry)));
            const due = answers.filter((answer): answer is JsonRpcResponse => answer !== null);
            return due.length ? JSON.stringify(due) : null;
        }
        const answer = await this.handleMessage(message);
        return answer ? JSON.stringify(answer) : null;
    }

    async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            return failure(null, INVALID_REQUEST, "Invalid request");
        }
        const record = message as Json;
        const notification = !("id" in record);
        const id = validId(record.id) ? record.id : null;
        if (typeof record.method !== "string") {
            // A response to a request of the server. This server sends no requests.
            if ("result" in record || "error" in record) return null;
            return notification ? null : failure(id, INVALID_REQUEST, "Invalid request");
        }
        if (!notification && !validId(record.id))
            return failure(null, INVALID_REQUEST, "Invalid id");
        try {
            const result = await this.dispatch(record.method, record.params);
            return notification ? null : success(id, result);
        } catch (error) {
            if (notification) {
                this.log(`Notification ${record.method} failed: ${errorMessage(error)}`);
                return null;
            }
            if (error instanceof RpcError) return failure(id, error.code, error.message);
            this.log(`Request ${record.method} failed: ${errorMessage(error)}`);
            return failure(id, INTERNAL_ERROR, errorMessage(error));
        }
    }

    private async dispatch(method: string, params: unknown): Promise<unknown> {
        if (method.startsWith("notifications/")) return null;
        switch (method) {
            case "initialize": {
                const requested =
                    params && typeof params === "object"
                        ? (params as Json).protocolVersion
                        : undefined;
                this.protocolVersion =
                    typeof requested === "string" &&
                    (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
                        ? requested
                        : MCP_PROTOCOL_VERSIONS[0];
                return {
                    protocolVersion: this.protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: {
                        name: "lune-memory",
                        title: "Lune Memory",
                        version: packageVersion(),
                    },
                    instructions: INSTRUCTIONS,
                };
            }
            case "ping":
                return {};
            case "tools/list":
                return { tools: MCP_TOOLS };
            case "tools/call": {
                if (!params || typeof params !== "object" || Array.isArray(params)) {
                    throw new RpcError(INVALID_PARAMS, "params must be an object");
                }
                const { name, arguments: toolArguments } = params as Json;
                if (typeof name !== "string" || !MCP_TOOLS.some((tool) => tool.name === name)) {
                    throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`);
                }
                return callMcpTool(this.context, name, toolArguments);
            }
            default:
                throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    }
}

/**
 * Serve MCP on a stream pair until the input ends. Requests run at the same time, and each answer
 * goes out when it is ready. At the end it waits for open requests and closes the backend.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
    const connection = new McpConnection(options);
    const log = options.log ?? (() => {});
    const open = new Set<Promise<void>>();
    const lines = createInterface({ input: options.input, crlfDelay: Infinity });
    for await (const line of lines) {
        const task = connection
            .handleLine(line)
            .then((answer) => {
                if (answer !== null) options.output.write(`${answer}\n`);
            })
            .catch((error: unknown) => log(`Cannot answer: ${errorMessage(error)}`));
        open.add(task);
        void task.finally(() => open.delete(task));
    }
    await Promise.allSettled([...open]);
    await options.backend.close();
}
