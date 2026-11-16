import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openTestDaemon, TEST_TOKEN, type Json, type TestDaemon } from "../harness/daemon.ts";

let daemon: TestDaemon;

beforeEach(async () => {
    daemon = await openTestDaemon();
});

afterEach(async () => {
    await daemon.close();
});

async function rawGet(url: string, headers: Record<string, string>) {
    return daemon.app.inject({ method: "GET", url, headers });
}

describe("auth, host and origin checks", () => {
    it("rejects a request without a token", async () => {
        const response = await rawGet("/api/health", { host: "127.0.0.1" });
        assert.equal(response.statusCode, 401);
    });

    it("rejects a wrong Bearer token", async () => {
        const response = await rawGet("/api/health", {
            host: "127.0.0.1",
            authorization: "Bearer wrong-token-not-real",
        });
        assert.equal(response.statusCode, 401);
    });

    it("rejects a token of the right length that differs", async () => {
        const wrong = `Bearer ${"x".repeat(TEST_TOKEN.length)}`;
        const response = await rawGet("/api/health", {
            host: "127.0.0.1",
            authorization: wrong,
        });
        assert.equal(response.statusCode, 401);
    });

    it("accepts the right token", async () => {
        const response = await daemon.api("GET", "/api/health");
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.version, "0.0.0-test");
        assert.equal(response.body.busy, false);
    });

    it("rejects a non-loopback Host header, even for the UI", async () => {
        for (const url of ["/api/health", "/"]) {
            const response = await rawGet(url, {
                host: "evil.example.com",
                authorization: `Bearer ${TEST_TOKEN}`,
            });
            assert.equal(response.statusCode, 403, url);
        }
    });

    it("accepts the localhost and bracketed IPv6 Host headers with a port", async () => {
        for (const host of ["localhost:4000", "[::1]:4000", "127.0.0.1:4000"]) {
            const response = await daemon.api("GET", "/api/health", undefined, { host });
            assert.equal(response.status, 200, host);
        }
    });

    it("rejects a foreign Origin on an API route", async () => {
        const response = await daemon.api("GET", "/api/health", undefined, {
            origin: "https://evil.example.com",
        });
        assert.equal(response.status, 403);
    });

    it("allows a loopback Origin or no Origin", async () => {
        const same = await daemon.api("GET", "/api/health", undefined, {
            origin: "http://127.0.0.1:4000",
        });
        assert.equal(same.status, 200);
        const none = await daemon.api("GET", "/api/health");
        assert.equal(none.status, 200);
    });

    it("answers an unknown API route with 404 after auth", async () => {
        const response = await daemon.api("GET", "/api/nope");
        assert.equal(response.status, 404);
        assert.match(response.body.error, /Not found/u);
    });

    it("decides auth by the matched route, so an encoded API path still needs the token", async () => {
        const anonymous = await rawGet("/%61pi/config", { host: "127.0.0.1" });
        assert.equal(anonymous.statusCode, 401);
        const authorized = await daemon.api("GET", "/%61pi/config");
        assert.equal(authorized.status, 200);
    });

    it("answers an unknown path without a token with 401 and no UI headers", async () => {
        for (const url of ["/nope", "/ui/missing.js"]) {
            const response = await rawGet(url, { host: "127.0.0.1" });
            assert.equal(response.statusCode, 401, url);
            assert.equal(response.headers["cache-control"], "no-store", url);
            assert.equal(response.headers["content-security-policy"], undefined, url);
        }
    });
});

describe("settings UI and headers", () => {
    it("serves the UI files with security headers and no auth", async () => {
        const expected: Array<[string, string, RegExp]> = [
            ["/", "stub", /^text\/html/u],
            ["/ui/app.js", "console.log", /^text\/javascript/u],
            ["/ui/app.css", "body{}", /^text\/css/u],
        ];
        for (const [url, content, type] of expected) {
            const response = await rawGet(url, { host: "127.0.0.1" });
            assert.equal(response.statusCode, 200, url);
            assert.ok(response.body.includes(content), url);
            assert.match(String(response.headers["content-type"]), type);
            assert.match(
                String(response.headers["content-security-policy"]),
                /default-src 'none'/u,
            );
            assert.match(
                String(response.headers["content-security-policy"]),
                /frame-ancestors 'none'/u,
            );
            assert.equal(response.headers["x-frame-options"], "DENY");
            assert.equal(response.headers["cache-control"], "no-cache");
            assert.equal(response.headers["x-content-type-options"], "nosniff");
        }
    });

    it("sends API responses with no-store and without the UI headers", async () => {
        const response = await daemon.api("GET", "/api/health");
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["content-security-policy"], undefined);
    });

    it("answers 404 when the UI files are missing", async () => {
        await daemon.close();
        daemon = await openTestDaemon({ uiDir: new URL("file:///nonexistent-lune-ui/") });
        const response = await rawGet("/", { host: "127.0.0.1" });
        assert.equal(response.statusCode, 404);
    });
});

describe("config", () => {
    it("returns the config and saves a valid update", async () => {
        const before = await daemon.api("GET", "/api/config");
        assert.equal(before.status, 200);
        assert.equal(before.body.importSeconds, 60);

        const next = {
            ...before.body,
            importSeconds: 120,
            dreaming: { ...before.body.dreaming, scanMinutes: 30 },
        };
        const put = await daemon.api("PUT", "/api/config", next);
        assert.equal(put.status, 200);
        assert.equal(put.body.importSeconds, 120);

        const after = await daemon.api("GET", "/api/config");
        assert.equal(after.body.importSeconds, 120);
        assert.equal(after.body.dreaming.scanMinutes, 30);
    });

    it("resets invalid values to the defaults instead of failing", async () => {
        const put = await daemon.api("PUT", "/api/config", {
            importSeconds: 1,
            generations: "many",
            dreaming: { model: "no-slash", thinking: "extreme", concurrency: 99 },
        });
        assert.equal(put.status, 200);
        assert.equal(put.body.importSeconds, 60);
        assert.equal(put.body.generations, 3);
        assert.equal(put.body.dreaming.model, null);
        assert.equal(put.body.dreaming.thinking, "low");
        assert.equal(put.body.dreaming.concurrency, 3);
    });

    it("rejects a config body that is not an object", async () => {
        const put = await daemon.api("PUT", "/api/config", [1, 2]);
        assert.equal(put.status, 400);
        assert.match(put.body.error, /JSON object/u);
    });
});

describe("notes, search, l1 and status", () => {
    it("writes, updates and retracts a note of the writer session", async () => {
        const writer = { writerHarness: "claude", writerSession: "s-1" };
        const created = await daemon.api("POST", "/api/notes", {
            title: "First",
            body: "Body one",
            ...writer,
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.status, "provisional");
        assert.equal(created.body.trust, "inference");
        const id = String(created.body.id);

        const updated = await daemon.api("PUT", `/api/notes/${id}`, {
            title: "Second",
            body: "Body two",
            harness: "claude",
            session: "s-1",
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.title, "Second");

        const retracted = await daemon.api("POST", `/api/notes/${id}/retract`, {
            harness: "claude",
            session: "s-1",
        });
        assert.equal(retracted.status, 200);
        assert.equal(retracted.body.status, "retired");
    });

    it("refuses to update a note from another session", async () => {
        const created = await daemon.api("POST", "/api/notes", {
            title: "Mine",
            body: "Body",
            writerHarness: "claude",
            writerSession: "s-1",
        });
        const response = await daemon.api("PUT", `/api/notes/${created.body.id}`, {
            title: "Theirs",
            body: "Body",
            harness: "claude",
            session: "s-other",
        });
        assert.ok(response.status >= 400 && response.status < 500, String(response.status));
        assert.equal(typeof response.body.error, "string");
    });

    it("answers 404 for an unknown note id", async () => {
        const response = await daemon.api("POST", "/api/notes/n-missing/retract", {});
        assert.equal(response.status, 404);
    });

    it("searches transcripts and returns an empty result on a fresh home", async () => {
        const response = await daemon.api("POST", "/api/search", { query: "anything" });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.hits, []);
    });

    it("assembles L1 for a folder", async () => {
        const response = await daemon.api("POST", "/api/l1", {
            cwd: daemon.env.folder("work"),
            harness: "pi",
            sessionId: "s-1",
        });
        assert.equal(response.status, 200);
    });

    it("reports status with daemon data and the note counts", async () => {
        await daemon.api("POST", "/api/notes", { title: "T", body: "B" });
        const response = await daemon.api("GET", "/api/status");
        assert.equal(response.status, 200);
        assert.equal(response.body.daemon.version, "0.0.0-test");
        assert.equal(response.body.daemon.busy, false);
        assert.equal(response.body.counts.items.provisional, 1);
    });

    it("runs an import with no harness enabled", async () => {
        const response = await daemon.api("POST", "/api/import", { harnesses: ["claude"] });
        assert.equal(response.status, 200);
        assert.equal(response.body.imported, 0);
    });

    it("lists runs and sessions", async () => {
        const runs = await daemon.api("GET", "/api/runs?limit=5");
        assert.equal(runs.status, 200);
        assert.ok(Array.isArray(runs.body));
        const sessions = await daemon.api("GET", "/api/sessions?limit=5");
        assert.deepEqual(sessions.body, []);
    });
});

describe("validation errors", () => {
    it("answers 400 with a clear message for invalid bodies and queries", async () => {
        const cases: Array<[() => Promise<{ status: number; body: Json }>, RegExp]> = [
            [
                () => daemon.api("POST", "/api/notes", { title: "x" }),
                /body must be a non-empty string/u,
            ],
            [
                () => daemon.api("POST", "/api/search", { query: "x", limit: 0 }),
                /limit must be an integer from 1 to 50/u,
            ],
            [() => daemon.api("GET", "/api/runs?limit=abc"), /limit must be an integer/u],
            [
                () => daemon.api("POST", "/api/import", { harnesses: ["vim"] }),
                /Unknown harness: vim/u,
            ],
            [
                () => daemon.api("POST", "/api/projects/split", { kind: "bogus", value: "x" }),
                /kind must be one of/u,
            ],
        ];
        for (const [run, message] of cases) {
            const response = await run();
            assert.equal(response.status, 400);
            assert.match(response.body.error, message);
        }
    });
});

describe("projects", () => {
    it("registers, lists, renames and merges projects", async () => {
        const one = await daemon.api("POST", "/api/projects", {
            path: daemon.env.folder("one"),
            name: "Alpha",
        });
        assert.equal(one.status, 201);
        assert.equal(one.body.name, "Alpha");
        const two = await daemon.api("POST", "/api/projects", { path: daemon.env.folder("two") });
        assert.equal(two.status, 201);

        const renamed = await daemon.api("POST", `/api/projects/${two.body.id}/rename`, {
            name: "Beta",
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.name, "Beta");

        const listed = await daemon.api("GET", "/api/projects");
        assert.deepEqual(listed.body.map((p: { name: string }) => p.name).sort(), [
            "Alpha",
            "Beta",
        ]);

        const merged = await daemon.api("POST", "/api/projects/merge", {
            source: two.body.id,
            target: one.body.id,
        });
        assert.equal(merged.status, 200);
        assert.deepEqual(merged.body, { source: two.body.id, target: one.body.id });

        const after = await daemon.api("GET", "/api/projects");
        assert.equal(after.body.length, 1);
        const withMerged = await daemon.api("GET", "/api/projects?merged=1");
        assert.equal(withMerged.body.length, 2);
    });

    it("splits a locator off a project with several locators", async () => {
        const one = await daemon.api("POST", "/api/projects", { path: daemon.env.folder("one") });
        const two = await daemon.api("POST", "/api/projects", { path: daemon.env.folder("two") });
        await daemon.api("POST", "/api/projects/merge", {
            source: two.body.id,
            target: one.body.id,
        });
        const locators = (await daemon.api("GET", "/api/projects")).body[0].locators;
        assert.equal(locators.length, 2);

        const split = await daemon.api("POST", "/api/projects/split", {
            kind: "path",
            value: locators[0].value,
            name: "Detached",
        });
        assert.equal(split.status, 200);
        assert.equal(split.body.project.name, "Detached");
    });

    it("answers 404 for a missing folder and an unknown project", async () => {
        // The 404s come from MemoryOperationError messages that say "not found" or "unknown".
        const missing = await daemon.api("POST", "/api/projects", {
            path: "/nonexistent-lune-dir",
        });
        assert.equal(missing.status, 404);
        const rename = await daemon.api("POST", "/api/projects/p-missing/rename", { name: "X" });
        assert.equal(rename.status, 404);
    });
});

describe("credentials", () => {
    it("lists provider names and types but never the key", async () => {
        const secret = "test-key-not-real-0123456789";
        const put = await daemon.api("PUT", "/api/credentials/anthropic", { key: secret });
        assert.equal(put.status, 200);
        assert.deepEqual(put.body, { ok: true });

        const list = await daemon.api("GET", "/api/credentials");
        assert.equal(list.status, 200);
        assert.deepEqual(list.body, [{ providerId: "anthropic", type: "api_key" }]);
        assert.ok(!list.text.includes(secret));
    });

    it("removes the credential when the key is empty", async () => {
        await daemon.api("PUT", "/api/credentials/anthropic", { key: "test-key-not-real" });
        await daemon.api("PUT", "/api/credentials/anthropic", { key: "" });
        const list = await daemon.api("GET", "/api/credentials");
        assert.deepEqual(list.body, []);
    });

    it("answers 404 for an unknown provider", async () => {
        const response = await daemon.api("PUT", "/api/credentials/no-such-provider", {
            key: "test-key-not-real",
        });
        assert.equal(response.status, 404);
    });
});
