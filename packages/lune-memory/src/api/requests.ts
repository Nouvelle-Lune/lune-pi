import { MemoryOperationError } from "../core/errors.ts";
import {
    isHarness,
    NOTE_KINDS,
    type Harness,
    type ItemKind,
    type SourceRef,
    type Trust,
} from "../core/types.ts";
import type { NoteInput } from "../memory/notes.ts";
import type { SearchOptions } from "../memory/search.ts";
import type { DreamRequest, ProviderInput } from "../service.ts";

/** An invalid request. The daemon answers with the status. */
export class RequestError extends Error {
    readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "RequestError";
        this.status = status;
    }
}

/**
 * HTTP status for an error of the service. Only explicit rule errors give 4xx: a
 * RequestError gives its own status, and a MemoryOperationError gives 404 when its message
 * names an unknown or missing thing, else 400. Every other error, such as a failed SQLite or
 * file operation, is a fault of the daemon and gives 500.
 */
export function errorStatus(error: unknown): number {
    if (error instanceof RequestError) return error.status;
    if (error instanceof MemoryOperationError) {
        return /\b(unknown|not found)\b/iu.test(error.message) ? 404 : 400;
    }
    return 500;
}

export type Body = Record<string, unknown>;

export function asBody(value: unknown): Body {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new RequestError("The request body must be a JSON object");
    }
    return value as Body;
}

export function reqString(body: Body, key: string): string {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) {
        throw new RequestError(`${key} must be a non-empty string`);
    }
    return value;
}

/** Undefined when the key is missing, null when the value is null. */
export function optString(body: Body, key: string): string | null | undefined {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") throw new RequestError(`${key} must be a string`);
    return value;
}

export function optBool(body: Body, key: string): boolean | undefined {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new RequestError(`${key} must be true or false`);
    return value;
}

export function optInt(body: Body, key: string, min: number, max: number): number | undefined {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new RequestError(`${key} must be an integer from ${min} to ${max}`);
    }
    return value;
}

export function optHarness(body: Body, key: string): Harness | null | undefined {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!isHarness(value)) throw new RequestError(`${key} must be pi, claude or codex`);
    return value;
}

export function reqHarness(body: Body, key: string): Harness {
    const value = optHarness(body, key);
    if (!value) throw new RequestError(`${key} must be pi, claude or codex`);
    return value;
}

function optStringList(body: Body, key: string): string[] | undefined {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry)) {
        throw new RequestError(`${key} must be a list of strings`);
    }
    return value as string[];
}

// ---------------------------------------------------------------------------------------------
// Request shapes. The daemon parses them from JSON. The HTTP client sends them as JSON.

export interface L1Request {
    cwd?: string | null;
    harness?: Harness | null;
    sessionId?: string | null;
    /** False leaves out the line that tells the agent to pass the session id to note tools. */
    announceSession?: boolean;
}

export function parseL1(body: Body): L1Request {
    const announceSession = optBool(body, "announceSession");
    return {
        cwd: optString(body, "cwd") ?? null,
        harness: optHarness(body, "harness") ?? null,
        sessionId: optString(body, "sessionId") ?? null,
        ...(announceSession !== undefined ? { announceSession } : {}),
    };
}

const TRUSTS: readonly Trust[] = ["inference", "tool", "user"];

function parseSources(value: unknown): SourceRef[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new RequestError("sources must be a list");
    if (value.length > 50) throw new RequestError("A note has at most 50 sources");
    return value.map((entry): SourceRef => {
        const source = asBody(entry);
        if (source.kind === "item") return { kind: "item", itemId: reqString(source, "itemId") };
        if (source.kind === "event") {
            return {
                kind: "event",
                harness: reqHarness(source, "harness"),
                sessionId: reqString(source, "sessionId"),
                eventKey: reqString(source, "eventKey"),
            };
        }
        throw new RequestError("A source has kind event or item");
    });
}

export function parseNoteWrite(body: Body): NoteInput {
    const kind = optString(body, "kind");
    if (kind && !NOTE_KINDS.includes(kind as ItemKind)) {
        throw new RequestError(`kind must be one of ${NOTE_KINDS.join(", ")}`);
    }
    const trust = optString(body, "trust");
    if (trust && !TRUSTS.includes(trust as Trust)) {
        throw new RequestError("trust must be inference, tool or user");
    }
    const sources = parseSources(body.sources);
    const cwd = optString(body, "cwd");
    const writerHarness = optHarness(body, "writerHarness");
    const writerSession = optString(body, "writerSession");
    const trigger = optString(body, "trigger");
    return {
        title: reqString(body, "title"),
        body: reqString(body, "body"),
        ...(kind ? { kind: kind as ItemKind } : {}),
        ...(trust ? { trust: trust as Trust } : {}),
        ...(cwd ? { cwd } : {}),
        ...(writerHarness ? { writerHarness } : {}),
        ...(writerSession ? { writerSession } : {}),
        ...(sources ? { sources } : {}),
        ...(trigger ? { trigger } : {}),
    };
}

export interface WriterRequest {
    harness: Harness | null;
    session: string | null;
}

export function parseWriter(body: Body): WriterRequest {
    return {
        harness: optHarness(body, "harness") ?? null,
        session: optString(body, "session") ?? null,
    };
}

export interface NoteUpdateRequest extends WriterRequest {
    title: string;
    body: string;
}

export function parseNoteUpdate(body: Body): NoteUpdateRequest {
    return { title: reqString(body, "title"), body: reqString(body, "body"), ...parseWriter(body) };
}

export interface SearchRequest extends SearchOptions {
    /** Folder of the caller. Without a project, the search stays in the project of this folder. */
    cwd?: string | null;
    /** Search every project. It wins over cwd. */
    allProjects?: boolean;
}

export function parseSearch(body: Body): SearchRequest {
    const projectId = optString(body, "projectId");
    const cwd = optString(body, "cwd");
    const harness = optHarness(body, "harness");
    const sessionId = optString(body, "sessionId");
    const since = optString(body, "since");
    const until = optString(body, "until");
    const limit = optInt(body, "limit", 1, 50);
    const context = optInt(body, "context", 0, 5);
    const includeMemoryDerived = optBool(body, "includeMemoryDerived");
    const allProjects = optBool(body, "allProjects");
    return {
        query: reqString(body, "query"),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(harness ? { harness } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(includeMemoryDerived !== undefined ? { includeMemoryDerived } : {}),
        ...(allProjects ? { allProjects } : {}),
    };
}

/** Search options for the service. All projects means no project filter. */
export function searchArguments(request: SearchRequest): SearchOptions & { cwd?: string | null } {
    const { allProjects, ...rest } = request;
    return allProjects ? { ...rest, projectId: null } : rest;
}

export function parseDream(body: Body): Omit<DreamRequest, "signal"> {
    const projectId = optString(body, "projectId");
    const sessions = optStringList(body, "sessions");
    return {
        trigger: "manual",
        force: optBool(body, "force") ?? false,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(sessions ? { sessions } : {}),
    };
}

/** The service checks the protocol, the id and the URL. */
export function parseProviderAdd(body: Body): ProviderInput {
    const name = optString(body, "name");
    const key = optString(body, "key");
    const scan = optBool(body, "scan");
    return {
        id: reqString(body, "id"),
        api: reqString(body, "api"),
        baseUrl: reqString(body, "baseUrl"),
        ...(name ? { name } : {}),
        ...(key ? { key } : {}),
        ...(scan !== undefined ? { scan } : {}),
    };
}

export function parseHarnessList(body: Body): Harness[] | undefined {
    const list = optStringList(body, "harnesses");
    if (!list) return undefined;
    for (const entry of list) {
        if (!isHarness(entry)) throw new RequestError(`Unknown harness: ${entry}`);
    }
    return list as Harness[];
}
