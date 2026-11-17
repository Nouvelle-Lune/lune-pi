import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import {
    asBody,
    errorStatus,
    optBool,
    optString,
    parseDream,
    parseHarnessList,
    parseL1,
    parseNoteUpdate,
    parseNoteWrite,
    parseSearch,
    parseWriter,
    reqHarness,
    reqString,
    RequestError,
    searchArguments,
    type Body,
} from "../api/requests.ts";
import { UNASSIGNED } from "../core/paths.ts";
import { isLocatorKind, LOCATOR_KINDS } from "../core/types.ts";
import { errorMessage } from "../core/util.ts";
import type { MemoryService, ServiceEvent } from "../service.ts";
import type { DaemonLog, DaemonScheduler } from "./scheduler.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join("; ");

const UI_FILES: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/ui/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

function hostName(host: string | undefined): string | null {
    if (!host) return null;
    try {
        return new URL(`http://${host}`).hostname;
    } catch {
        return null;
    }
}

function loopbackOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

function pathOf(url: string): string {
    const index = url.indexOf("?");
    return index < 0 ? url : url.slice(0, index);
}

/**
 * True only for a request that the router matched to a settings UI file. The check uses the
 * matched route, not the raw URL, because the router decodes the path: `/%61pi/config` reaches
 * the /api/config handler. Every other request, also an unknown path, needs the token.
 */
function isPublic(request: FastifyRequest): boolean {
    const route = request.routeOptions.url;
    return route !== undefined && Object.hasOwn(UI_FILES, route);
}

function bodyOf(request: FastifyRequest): Body {
    return asBody(request.body);
}

function queryOf(request: FastifyRequest): Record<string, string | undefined> {
    const query = request.query;
    return query && typeof query === "object" ? (query as Record<string, string | undefined>) : {};
}

function paramOf(request: FastifyRequest, key: string): string {
    const value = (request.params as Record<string, string | undefined> | undefined)?.[key];
    if (!value) throw new RequestError(`Missing ${key}`);
    return value;
}

function intQuery(value: string | undefined, key: string): number | undefined {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new RequestError(`${key} must be an integer`);
    return parsed;
}

function flagQuery(value: string | undefined): boolean {
    return value === "1" || value === "true";
}

export interface AppOptions {
    token: string;
    version: string;
    scheduler?: DaemonScheduler;
    /** Folder with the settings UI files. The default is the ui folder of the package. */
    uiDir?: URL;
    log?: DaemonLog;
    startedAt?: string;
}

/**
 * The local API of the daemon. It accepts only loopback Host headers, so a DNS rebinding page
 * cannot reach it. Only the settings UI files are public. Every other route needs the Bearer
 * token from daemon.json.
 */
export function createApp(service: MemoryService, options: AppOptions): FastifyInstance {
    const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });
    const expected = Buffer.from(`Bearer ${options.token}`);
    const uiDir = options.uiDir ?? new URL("../../ui/", import.meta.url);
    const log: DaemonLog = options.log ?? ((message, details) => service.log(message, details));
    const streams = new Set<() => void>();
    const scheduler = options.scheduler;

    app.addHook("onRequest", async (request, reply) => {
        const host = hostName(request.headers.host);
        if (!host || !LOOPBACK_HOSTS.has(host)) {
            reply.code(403).send({ error: "The daemon accepts only loopback hosts" });
            return reply;
        }
        if (isPublic(request)) return;
        const origin = request.headers.origin;
        if (origin !== undefined && !loopbackOrigin(origin)) {
            reply.code(403).send({ error: "Cross-origin requests are not allowed" });
            return reply;
        }
        const given = Buffer.from(request.headers.authorization ?? "");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            reply.code(401).send({ error: "Missing or wrong token" });
            return reply;
        }
    });

    app.addHook("onSend", async (request, reply, payload) => {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("Cross-Origin-Resource-Policy", "same-origin");
        if (isPublic(request)) {
            reply.header("Content-Security-Policy", CSP);
            reply.header("X-Frame-Options", "DENY");
            reply.header("Cache-Control", "no-cache");
        } else {
            reply.header("Cache-Control", "no-store");
        }
        return payload;
    });

    app.setErrorHandler((error, request, reply) => {
        const own = (error as { statusCode?: unknown }).statusCode;
        const status =
            typeof own === "number" && own >= 400 && own < 500 ? own : errorStatus(error);
        // Logging a failed log read would make the page retry itself through the log event.
        if (status >= 500 && request.routeOptions.url !== "/api/logs") {
            log(`Request failed: ${errorMessage(error)}`, { level: "error", source: "http" });
        }
        reply.code(status).send({ error: errorMessage(error) });
    });

    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({ error: `Not found: ${request.method} ${pathOf(request.url)}` });
    });

    // Settings UI ---------------------------------------------------------------------------

    for (const [route, entry] of Object.entries(UI_FILES)) {
        app.get(route, async (_request, reply) => {
            let content: Buffer;
            try {
                content = readFileSync(new URL(entry.file, uiDir));
            } catch {
                return reply.code(404).send({ error: "The settings UI files are missing" });
            }
            return reply.type(entry.type).send(content);
        });
    }

    // Agent routes --------------------------------------------------------------------------

    app.get("/api/health", async () => ({
        ok: true,
        version: options.version,
        pid: process.pid,
        busy: scheduler?.busy ?? false,
    }));

    app.post("/api/l1", async (request) => service.l1(parseL1(bodyOf(request))));

    app.post("/api/notes", async (request, reply) => {
        const item = service.noteWrite(parseNoteWrite(bodyOf(request)));
        return reply.code(201).send(item);
    });

    app.put("/api/notes/:id", async (request) => {
        const update = parseNoteUpdate(bodyOf(request));
        return service.noteUpdate(paramOf(request, "id"), update);
    });

    app.post("/api/notes/:id/retract", async (request) =>
        service.noteRetract(paramOf(request, "id"), parseWriter(bodyOf(request))),
    );

    app.post("/api/search", async (request) =>
        service.search(searchArguments(parseSearch(bodyOf(request)))),
    );

    app.post("/api/location", async (request) =>
        service.location(optString(bodyOf(request), "cwd") ?? null),
    );

    // Index operations ----------------------------------------------------------------------

    app.post("/api/import", async (request) =>
        service.importNow(parseHarnessList(bodyOf(request))),
    );

    app.post("/api/dream", async (request, reply) => {
        const body = bodyOf(request);
        const dreamRequest = parseDream(body);
        const wait = optBool(body, "wait") ?? true;
        const run = scheduler ? scheduler.dream(dreamRequest) : service.dream(dreamRequest);
        if (wait) return await run;
        run.catch((error: unknown) =>
            log(`Pass failed: ${errorMessage(error)}`, { level: "error", source: "dreaming" }),
        );
        return reply.code(202).send({ started: true });
    });

    app.post("/api/regenerate", async () => ({ generation: service.regenerate() }));

    app.post("/api/runs/:id/revert", async (request) => {
        const id = intQuery(paramOf(request, "id"), "id");
        if (id === undefined) throw new RequestError("Missing id");
        return service.revert(id, { reprocess: optBool(bodyOf(request), "reprocess") ?? false });
    });

    app.post("/api/sessions/forget", async (request) => {
        const body = bodyOf(request);
        return service.forget(reqHarness(body, "harness"), reqString(body, "sessionId"));
    });

    // Read models ---------------------------------------------------------------------------

    app.get("/api/status", async () => ({
        ...service.status(),
        daemon: {
            pid: process.pid,
            version: options.version,
            busy: scheduler?.busy ?? false,
            startedAt: options.startedAt ?? null,
        },
    }));

    app.get("/api/logs", async () => service.logs());

    app.get("/api/runs", async (request) =>
        service.runs(intQuery(queryOf(request).limit, "limit")),
    );

    app.get("/api/projects", async (request) =>
        service.projects(flagQuery(queryOf(request).merged)),
    );

    app.get("/api/sessions", async (request) => {
        const query = queryOf(request);
        const limit = intQuery(query.limit, "limit");
        const project = query.project;
        return service.sessions({
            ...(limit !== undefined ? { limit } : {}),
            ...(project ? { projectId: project === UNASSIGNED ? null : project } : {}),
        });
    });

    // Config and credentials ----------------------------------------------------------------

    app.get("/api/config", async () => service.getConfig());

    app.put("/api/config", async (request) => service.setConfig(bodyOf(request)));

    app.get("/api/credentials", async () => service.credentials());

    app.put("/api/credentials/:provider", async (request) => {
        const key = optString(bodyOf(request), "key") ?? "";
        await service.setCredential(paramOf(request, "provider"), key);
        return { ok: true };
    });

    app.get("/api/providers", async () => service.providers());

    // Projects ------------------------------------------------------------------------------

    app.post("/api/projects", async (request, reply) => {
        const body = bodyOf(request);
        const name = optString(body, "name");
        const project = service.register(reqString(body, "path"), name ?? undefined);
        return reply.code(201).send(project);
    });

    app.post("/api/projects/merge", async (request) => {
        const body = bodyOf(request);
        return service.merge(reqString(body, "source"), reqString(body, "target"));
    });

    app.post("/api/projects/split", async (request) => {
        const body = bodyOf(request);
        const kind = reqString(body, "kind");
        if (!isLocatorKind(kind)) {
            throw new RequestError(`kind must be one of ${LOCATOR_KINDS.join(", ")}`);
        }
        const name = optString(body, "name");
        return service.split(kind, reqString(body, "value"), name ?? undefined);
    });

    app.post("/api/projects/:id/rename", async (request) =>
        service.rename(paramOf(request, "id"), reqString(bodyOf(request), "name")),
    );

    // Runtime events ------------------------------------------------------------------------

    app.get("/api/events", (request: FastifyRequest, reply: FastifyReply) => {
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Content-Type-Options": "nosniff",
            "X-Accel-Buffering": "no",
        });
        const write = (text: string): void => {
            if (!raw.writableEnded) raw.write(text);
        };
        write(`event: ready\ndata: ${JSON.stringify({ version: options.version })}\n\n`);
        const unsubscribe = service.on((event: ServiceEvent) => {
            write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const ping = setInterval(() => write(": ping\n\n"), 25_000);
        const close = (): void => {
            clearInterval(ping);
            unsubscribe();
            streams.delete(end);
        };
        const end = (): void => {
            close();
            if (!raw.writableEnded) raw.end();
        };
        streams.add(end);
        request.raw.on("close", close);
    });

    app.addHook("preClose", async () => {
        for (const end of [...streams]) end();
    });

    return app;
}
