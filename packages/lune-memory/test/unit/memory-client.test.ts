import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, type TestContext } from "node:test";

import type { DaemonInfo } from "../../src/api/daemon-info.ts";
import { DaemonRequestError, DaemonUnavailableError } from "../../src/client/connection.ts";
import { MemoryClient } from "../../src/client/memory-client.ts";
import type { MemoryPaths } from "../../src/core/paths.ts";
import { sandbox } from "../harness/cli.ts";

function infoFor(port: number): DaemonInfo {
    return {
        pid: process.pid,
        port,
        token: "test-token-not-real",
        url: `http://127.0.0.1:${port}`,
        startedAt: "2026-01-01T00:00:00.000Z",
        version: "0.0.0",
    };
}

function publish(paths: MemoryPaths, port: number): void {
    writeFileSync(paths.daemon, JSON.stringify(infoFor(port)));
}

async function fakeDaemon(
    t: TestContext,
    status: number,
    body: unknown,
): Promise<{ port: number; paths: string[] }> {
    const requested: string[] = [];
    const server: Server = createServer((req, res) => {
        requested.push(`${req.method} ${req.url}`);
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        req.resume();
        res.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return { port: (server.address() as AddressInfo).port, paths: requested };
}

async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
}

describe("MemoryClient routing", () => {
    it("uses the running daemon and does not open the local service", async (t) => {
        const box = sandbox(t);
        const daemon = await fakeDaemon(t, 200, { home: "from-daemon" });
        publish(box.paths, daemon.port);
        const client = new MemoryClient({ home: box.home });
        t.after(() => client.close());

        const actual = await client.location("/work");

        assert.deepEqual(actual, { home: "from-daemon" });
        assert.deepEqual(daemon.paths, ["POST /api/location"]);
        assert.equal(
            (client as unknown as { local: unknown }).local,
            null,
            "the local service stays closed",
        );
    });

    it("falls back to the local service when the daemon refuses the connection", async (t) => {
        const box = sandbox(t);
        publish(box.paths, await closedPort());
        const client = new MemoryClient({ home: box.home });
        t.after(() => client.close());

        const actual = await client.location(box.root);

        assert.equal(actual.home, box.home);
    });

    it("falls back to the local service when no daemon runs and auto start is off", async (t) => {
        const box = sandbox(t);
        const client = new MemoryClient({ home: box.home, autoStart: false });
        t.after(() => client.close());

        const actual = await client.location(box.root);

        assert.equal(actual.home, box.home);
    });

    it("does not fall back on a daemon error status", async (t) => {
        const box = sandbox(t);
        const daemon = await fakeDaemon(t, 500, { error: "database is locked" });
        publish(box.paths, daemon.port);
        const client = new MemoryClient({ home: box.home });
        t.after(() => client.close());

        await assert.rejects(client.location(box.root), (error: unknown) => {
            assert.ok(error instanceof DaemonRequestError);
            assert.equal(error.message, "database is locked");
            return true;
        });
        assert.equal((client as unknown as { local: unknown }).local, null);
    });

    it("does not fall back on a timeout of the daemon", async (t) => {
        const box = sandbox(t);
        const server = createServer(() => {
            // Never answer.
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        publish(box.paths, (server.address() as AddressInfo).port);
        const client = new MemoryClient({ home: box.home });
        t.after(() => client.close());

        await assert.rejects(
            client.call("POST", "/api/location", {}, () => "local", 50),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.ok(!(error instanceof DaemonUnavailableError));
                return true;
            },
        );
    });

    it("throws DaemonUnavailableError when local fallback is off and no daemon answers", async (t) => {
        const box = sandbox(t);
        const client = new MemoryClient({
            home: box.home,
            autoStart: false,
            localFallback: false,
        });

        await assert.rejects(client.location(box.root), DaemonUnavailableError);

        publish(box.paths, await closedPort());
        await assert.rejects(client.location(box.root), DaemonUnavailableError);
    });

    it("sends note operations to encoded daemon routes", async (t) => {
        const box = sandbox(t);
        const daemon = await fakeDaemon(t, 200, {});
        publish(box.paths, daemon.port);
        const client = new MemoryClient({ home: box.home });
        t.after(() => client.close());

        await client.noteUpdate("a/b", { title: "t", body: "b", harness: "pi", session: "s" });
        await client.noteRetract("a/b", { harness: "pi", session: "s" });

        assert.deepEqual(daemon.paths, ["PUT /api/notes/a%2Fb", "POST /api/notes/a%2Fb/retract"]);
    });
});

describe("MemoryClient daemon start throttle", () => {
    it("asks for a daemon at most once a minute", async (t) => {
        // A live lock holder (this process) with no daemon.json makes ensureDaemon wait for the
        // file. A daemon.json that appears during the wait ends the wait with a result.
        const box = sandbox(t, { autoStart: true });
        writeFileSync(box.paths.lock, String(process.pid));
        let now = 1_000_000_000_000;
        t.mock.method(Date, "now", () => now);
        const client = new MemoryClient({ home: box.home });

        const appearSoon = (): void => {
            setTimeout(() => publish(box.paths, 4321), 150);
        };

        appearSoon();
        const first = await client.daemon();
        rmSync(box.paths.daemon);

        // Within the minute: no new attempt, so the file that appears later is not awaited.
        appearSoon();
        now += 30_000;
        const throttled = await client.daemon();
        await new Promise((done) => setTimeout(done, 300));
        rmSync(box.paths.daemon);

        appearSoon();
        now += 31_000;
        const again = await client.daemon();

        assert.equal(first?.port, 4321);
        assert.equal(throttled, null);
        assert.equal(again?.port, 4321);
    });
});
