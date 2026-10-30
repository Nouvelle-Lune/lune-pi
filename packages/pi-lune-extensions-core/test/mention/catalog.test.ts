import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionCatalog } from "../../src/mention/catalog.ts";
import { PiSessions } from "../../src/mention/pi.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

const day = (n: number) => Date.parse(`2026-02-${String(n).padStart(2, "0")}T00:00:00.000Z`);

async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-catalog-"));
    const { agentDir } = isolateExternalSessions(t, root);
    t.after(() => rm(root, { recursive: true, force: true }));
    // A directory outside <agentDir>/sessions is a custom store that holds every session itself.
    const customDir = path.join(root, "custom-sessions");
    await mkdir(customDir, { recursive: true });
    /** Writes one session whose only message is `days` days into February 2026. */
    const write = async (
        directory: string,
        id: string,
        days = 1,
        build?: (file: SessionFile) => void,
    ) => {
        const file = new SessionFile(id, `/work/${id}`);
        file.message({ role: "user", content: `hello ${id}`, timestamp: day(days) });
        build?.(file);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), file.jsonl());
    };
    return { root, agentDir, customDir, write };
}

const silent = () => assert.fail("no background error");
const ids = (sessions: readonly { id: string }[]) => sessions.map((session) => session.id);

test("a custom store lists the same sessions as SessionManager.listAll, newest activity first", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-old-00000001", 3);
    await write(customDir, "sess-new-00000002", 9, (file) => {
        file.assistant([
            { type: "thinking", thinking: "x" },
            { type: "text", text: "answer" },
        ]);
        file.toolResult("read", "body");
        file.add({ type: "session_info", name: "Named" });
    });
    await write(customDir, "sess-mid-00000003", 5);
    const catalog = new SessionCatalog(customDir, silent);
    t.after(() => catalog.dispose());

    const expected = await SessionManager.listAll(customDir);
    const actual = await catalog.list();

    assert.deepEqual(ids(actual), ["sess-new-00000002", "sess-mid-00000003", "sess-old-00000001"]);
    assert.deepEqual(
        actual,
        expected.map((session) => ({ ...session, source: "pi" })),
    );
    assert.equal(actual[0]!.name, "Named");
});

test("a project folder of the default store lists every project, like listAll", async (t) => {
    const { agentDir, write } = await fixture(t);
    const first = path.join(agentDir, "sessions", "--work-a--");
    const second = path.join(agentDir, "sessions", "--work-b--");
    await write(first, "proj-a-00000000001", 2);
    await write(second, "proj-b-00000000002", 4);
    const catalog = new SessionCatalog(first, silent);
    t.after(() => catalog.dispose());

    const expected = await SessionManager.listAll();
    const actual = await catalog.list();

    assert.deepEqual(ids(actual), ["proj-b-00000000002", "proj-a-00000000001"]);
    assert.deepEqual(
        actual,
        expected.map((session) => ({ ...session, source: "pi" })),
    );
});

test("an empty session directory lists every project of the default store", async (t) => {
    const { agentDir, write } = await fixture(t);
    await write(path.join(agentDir, "sessions", "--work-a--"), "proj-a-00000000001");
    const catalog = new SessionCatalog("", silent);
    t.after(() => catalog.dispose());

    assert.deepEqual(ids(await catalog.list()), ["proj-a-00000000001"]);
});

test("a subagent run session beside the definitions is never returned by the default store", async (t) => {
    const { agentDir, write } = await fixture(t);
    await write(path.join(agentDir, "sessions", "--work-a--"), "proj-a-00000000001");
    // The literal layout of the subagent design: <agentDir>/lune-subagents/sessions/<parent>/<run>.jsonl
    const runDir = path.join(agentDir, "lune-subagents", "sessions", "proj-a-00000000001");
    const run = new SessionFile("run-b-00000000002", "/work/run-b-00000000002");
    run.message({ role: "user", content: "run task", timestamp: day(5) });
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run-b-00000000002.jsonl"), run.jsonl());
    const catalog = new SessionCatalog("", silent);
    t.after(() => catalog.dispose());

    assert.deepEqual(ids(await catalog.list()), ["proj-a-00000000001"]);
});

test("list waits for the first load only and later lists serve the cache", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    t.after(() => catalog.dispose());
    const list = t.mock.method(PiSessions.prototype, "list");

    const first = await catalog.list();
    await write(customDir, "sess-two-000000002", 2);
    const second = await catalog.list();

    assert.equal(first.length, 1);
    assert.strictEqual(second, first);
    assert.equal(list.mock.callCount(), 1);
});

test("reload reads the sessions again and concurrent callers share one load", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    t.after(() => catalog.dispose());
    await catalog.reload();
    await write(customDir, "sess-two-000000002", 2);
    const list = t.mock.method(PiSessions.prototype, "list");

    const first = catalog.reload();
    const second = catalog.reload();
    const reloaded = await first;

    assert.strictEqual(first, second);
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(ids(reloaded), ["sess-two-000000002", "sess-one-000000001"]);
    assert.strictEqual(catalog.snapshot(), reloaded);
});

test("snapshot is empty before the first load, does not wait, and starts the load", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    t.after(() => catalog.dispose());
    const list = t.mock.method(PiSessions.prototype, "list");

    const before = catalog.snapshot();
    // The load snapshot started is the shared one.
    const loaded = await catalog.reload();

    assert.deepEqual(before, []);
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(ids(loaded), ["sess-one-000000001"]);
    assert.strictEqual(catalog.snapshot(), loaded);
});

test("a snapshot younger than 60 seconds starts no reload and an older one starts a background reload", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    t.after(() => catalog.dispose());
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    await catalog.reload();
    await write(customDir, "sess-two-000000002", 2);
    const list = t.mock.method(PiSessions.prototype, "list");
    // snapshot() calls reload() synchronously, so this seam shows what it started before any I/O.
    const reload = t.mock.method(catalog, "reload");

    t.mock.timers.tick(59_000);
    const fresh = catalog.snapshot();
    const reloadsWhenFresh = reload.mock.callCount();
    t.mock.timers.tick(2_000);
    const stale = catalog.snapshot();
    const reloadsWhenStale = reload.mock.callCount();
    // The test's own call joins the load the stale snapshot started; a separate load would
    // make the list count 2.
    const refreshed = await catalog.reload();

    assert.equal(fresh.length, 1);
    assert.equal(reloadsWhenFresh, 0);
    assert.equal(stale.length, 1, "the stale snapshot does not wait for the reload");
    assert.equal(reloadsWhenStale, 1);
    assert.equal(reload.mock.callCount(), 2);
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(ids(refreshed), ["sess-two-000000002", "sess-one-000000001"]);
});

test("a failed background reload is reported and the cached list stays", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    let catalog!: SessionCatalog;
    const reported = new Promise<unknown>((resolve) => {
        catalog = new SessionCatalog(customDir, resolve);
    });
    t.after(() => catalog.dispose());
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const cached = await catalog.reload();
    t.mock.method(PiSessions.prototype, "list", async () => {
        throw new Error("disk gone");
    });
    t.mock.timers.tick(61_000);

    catalog.snapshot();
    const error = await reported;

    assert.equal((error as Error).message, "disk gone");
    assert.strictEqual(catalog.snapshot(), cached);
});

test("reload after dispose rejects", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    await catalog.reload();

    catalog.dispose();

    await assert.rejects(catalog.reload());
});

test("a load that finishes after dispose is rejected and does not replace the list", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const catalog = new SessionCatalog(customDir, silent);
    const cached = await catalog.reload();
    await write(customDir, "sess-two-000000002", 2);

    const pending = catalog.reload();
    catalog.dispose();

    await assert.rejects(pending);
    assert.strictEqual(catalog.snapshot(), cached);
});

test("a background failure after dispose is not reported", async (t) => {
    const { customDir, write } = await fixture(t);
    await write(customDir, "sess-one-000000001");
    const errors: unknown[] = [];
    const catalog = new SessionCatalog(customDir, (error) => errors.push(error));
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    await catalog.reload();
    t.mock.method(PiSessions.prototype, "list", async () => {
        throw new Error("disk gone");
    });
    t.mock.timers.tick(61_000);
    catalog.dispose();

    catalog.snapshot();
    // The background reload is the shared one; the snapshot's own handler runs before this one.
    await assert.rejects(catalog.reload(), /disk gone|abort/i);

    assert.deepEqual(errors, []);
});
