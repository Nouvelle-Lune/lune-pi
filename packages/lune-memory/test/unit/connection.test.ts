import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { DaemonInfo } from "../../src/api/daemon-info.ts";
import {
    cliPath,
    DaemonRequestError,
    DaemonUnavailableError,
    daemonRequest,
    ensureDaemon,
} from "../../src/client/connection.ts";
import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";

const TOKEN = "test-token-not-real";

interface Seen {
    method?: string;
    url?: string;
    authorization?: string;
    contentType?: string;
    body: string;
}

async function startServer(
    t: TestContext,
    respond: (res: ServerResponse) => void,
): Promise<{ info: DaemonInfo; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const entry: Seen = { body: Buffer.concat(chunks).toString("utf8") };
            if (req.method) entry.method = req.method;
            if (req.url) entry.url = req.url;
            if (req.headers.authorization) entry.authorization = req.headers.authorization;
            if (req.headers["content-type"]) entry.contentType = req.headers["content-type"];
            seen.push(entry);
            respond(res);
        });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const port = (server.address() as AddressInfo).port;
    return { info: infoFor(port), seen };
}

function infoFor(port: number, pid: number = process.pid): DaemonInfo {
    return {
        pid,
        port,
        token: TOKEN,
        url: `http://127.0.0.1:${port}`,
        startedAt: "2026-01-01T00:00:00.000Z",
        version: "0.0.0",
    };
}

/** A port with no listener: bind to port 0, read the port, close. */
async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
}

function tempPaths(t: TestContext): MemoryPaths {
    const root = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    return memoryPaths(home);
}

describe("daemonRequest", () => {
    it("sends the bearer token and a JSON body, and returns the parsed answer", async (t) => {
        const { info, seen } = await startServer(t, (res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
        });

        const actual = await daemonRequest<{ ok: boolean }>(info, "POST", "/api/x", { a: 1 });

        assert.deepEqual(actual, { ok: true });
        assert.equal(seen[0]?.method, "POST");
        assert.equal(seen[0]?.url, "/api/x");
        assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
        assert.equal(seen[0]?.contentType, "application/json");
        assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), { a: 1 });
    });

    it("sends no body and no content type for a request without body", async (t) => {
        const { info, seen } = await startServer(t, (res) => res.end("{}"));

        await daemonRequest(info, "GET", "/api/y");

        assert.equal(seen[0]?.contentType, undefined);
        assert.equal(seen[0]?.body, "");
    });

    it("returns null for an empty answer and the text for a non-JSON answer", async (t) => {
        let next = "";
        const { info } = await startServer(t, (res) => res.end(next));

        next = "";
        const empty = await daemonRequest(info, "GET", "/a");
        next = "plain text";
        const text = await daemonRequest(info, "GET", "/a");

        assert.equal(empty, null);
        assert.equal(text, "plain text");
    });

    it("throws DaemonRequestError with the server error text and status", async (t) => {
        const { info } = await startServer(t, (res) => {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "Note is retracted" }));
        });

        await assert.rejects(daemonRequest(info, "POST", "/api/notes"), (error: unknown) => {
            assert.ok(error instanceof DaemonRequestError);
            assert.equal(error.message, "Note is retracted");
            assert.equal(error.status, 409);
            return true;
        });
    });

    it("uses a generic message when the error body has no error text", async (t) => {
        const { info } = await startServer(t, (res) => {
            res.statusCode = 500;
            res.end("boom");
        });

        await assert.rejects(daemonRequest(info, "GET", "/a"), (error: unknown) => {
            assert.ok(error instanceof DaemonRequestError);
            assert.equal(error.message, "The daemon answered 500");
            assert.equal(error.status, 500);
            return true;
        });
    });

    it("maps a refused connection to DaemonUnavailableError", async () => {
        const info = infoFor(await closedPort());

        await assert.rejects(daemonRequest(info, "GET", "/a"), DaemonUnavailableError);
    });

    it("maps ECONNREFUSED nested in cause or errors to DaemonUnavailableError", async (t) => {
        const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        const shapes = [
            new TypeError("fetch failed", { cause: refused }),
            Object.assign(new Error("all failed"), { errors: [new Error("x"), refused] }),
            new TypeError("fetch failed", { cause: new AggregateError([refused]) }),
        ];
        for (const shape of shapes) {
            t.mock.method(globalThis, "fetch", async () => {
                throw shape;
            });
            await assert.rejects(daemonRequest(infoFor(1), "GET", "/a"), DaemonUnavailableError);
            t.mock.restoreAll();
        }
    });

    it("passes other network errors through unchanged", async (t) => {
        const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
        t.mock.method(globalThis, "fetch", async () => {
            throw new TypeError("fetch failed", { cause: reset });
        });

        await assert.rejects(daemonRequest(infoFor(1), "GET", "/a"), (error: unknown) => {
            assert.ok(error instanceof TypeError);
            assert.ok(!(error instanceof DaemonUnavailableError));
            return true;
        });
    });

    it("does not map a timeout to DaemonUnavailableError", async (t) => {
        const { info } = await startServer(t, () => {
            // Never answer.
        });

        await assert.rejects(
            daemonRequest(info, "GET", "/slow", undefined, 50),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.ok(!(error instanceof DaemonUnavailableError));
                assert.ok(!(error instanceof DaemonRequestError));
                return true;
            },
        );
    });
});

describe("cliPath", () => {
    it("points to cli.ts next to the client folder when run from source", () => {
        const actual = cliPath();

        assert.equal(basename(actual), "cli.ts");
        assert.equal(basename(dirname(actual)), "src");
    });
});

describe("ensureDaemon", () => {
    it("returns null when no daemon runs and auto start is off", async (t) => {
        const paths = tempPaths(t);

        const actual = await ensureDaemon(paths, { autoStart: false, timeoutMs: 50 });

        assert.equal(actual, null);
    });

    it("returns the daemon data of a live process without starting anything", async (t) => {
        const paths = tempPaths(t);
        writeFileSync(paths.daemon, JSON.stringify(infoFor(4321)));

        const actual = await ensureDaemon(paths, { autoStart: false });

        assert.equal(actual?.port, 4321);
        assert.equal(actual?.token, TOKEN);
    });

    it("ignores daemon.json of a process that is gone", async (t) => {
        const paths = tempPaths(t);
        writeFileSync(paths.daemon, JSON.stringify(infoFor(4321, 2_147_483_646)));

        const actual = await ensureDaemon(paths, { autoStart: false, timeoutMs: 50 });

        assert.equal(actual, null);
    });
});

// spawnDaemon argument order (--disable-warning=ExperimentalWarning, cliPath, daemon, run, --home,
// home) is not tested: mocking node:child_process needs `mock.module`, which Node only exposes
// with --experimental-test-module-mocks, and the suite runs with --experimental-strip-types only.
