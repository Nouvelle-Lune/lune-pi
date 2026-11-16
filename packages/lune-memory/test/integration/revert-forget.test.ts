import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MemoryOperationError } from "../../src/core/errors.ts";
import type { SourceRef } from "../../src/core/types.ts";
import { itemFileName } from "../../src/memory/projection.ts";
import {
    deleteItem,
    getItem,
    getRun,
    getSession,
    listEvents,
    startRun,
} from "../../src/store/rows.ts";
import {
    commitRun,
    createMemoryEnv,
    createRepo,
    makeItem,
    type MemoryEnv,
} from "../harness/memory.ts";

let env: MemoryEnv;
let repo: string;
let projectId: string;

beforeEach(async () => {
    env = await createMemoryEnv();
    repo = createRepo(env.folder("app"));
    const resolution = env.service.resolver.resolve(repo);
    assert.ok(resolution);
    projectId = resolution.projectId;
});

afterEach(() => {
    env.cleanup();
});

function notePage(itemId: string): string[] {
    const dir = join(env.service.paths.views, "projects", projectId, "notes");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(itemId)) : [];
}

describe("revert", () => {
    it("restores the earlier state of changed items and deletes created ones", () => {
        const original = makeItem({ projectId, title: "Original", body: "Before the run." });
        commitRun(env.store, { projectId, changes: [{ before: null, after: original }] });
        const created = makeItem({ projectId, title: "Created", body: "New in the run." });
        const runId = commitRun(env.store, {
            projectId,
            changes: [
                { before: original, after: { ...original, title: "Changed", body: "After." } },
                { before: null, after: created },
            ],
        });
        env.service.regenerate();
        assert.equal(notePage(created.id).length, 1);

        const result = env.service.revert(runId);

        assert.equal(result.runId, runId);
        assert.equal(result.items, 2);
        assert.equal(getItem(env.store, created.id), null);
        const restored = getItem(env.store, original.id);
        assert.equal(restored?.title, "Original");
        assert.equal(restored?.body, "Before the run.");
        assert.equal(getRun(env.store, runId)?.status, "reverted");
        const record = getRun(env.store, result.revertRun);
        assert.equal(record?.kind, "revert");
        assert.equal(record?.status, "ok");
        assert.equal(notePage(created.id).length, 0);
        assert.deepEqual(notePage(original.id), [`${itemFileName(restored ?? original)}.md`]);
    });

    it("restores an item that the run retired", () => {
        const item = makeItem({ projectId, title: "Keep me" });
        commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });
        const runId = commitRun(env.store, {
            projectId,
            changes: [{ before: item, after: { ...item, status: "retired" } }],
        });

        env.service.revert(runId);

        assert.equal(getItem(env.store, item.id)?.status, "active");
    });

    it("refuses while a later run changed the same item, and works after reverting that run", () => {
        const item = makeItem({ projectId, title: "V1" });
        const first = commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });
        const second = commitRun(env.store, {
            projectId,
            changes: [{ before: item, after: { ...item, title: "V2" } }],
        });

        assert.throws(() => env.service.revert(first), /Later runs changed the same items/u);
        assert.equal(getItem(env.store, item.id)?.title, "V2");

        env.service.revert(second);
        env.service.revert(first);

        assert.equal(getItem(env.store, item.id), null);
    });

    it("marks the sessions of the run unprocessed only when asked", () => {
        env.writePiSession({
            id: "s1",
            cwd: repo,
            messages: [{ role: "user", text: "Remember the decision." }],
        });
        env.importNow();
        const markProcessed = (): void => {
            env.store.run("UPDATE sessions SET processed_revision = revision");
            env.store.run("UPDATE events SET processed_hash = hash");
        };
        const make = (): number =>
            commitRun(env.store, {
                projectId,
                sessions: ["pi:s1"],
                changes: [{ before: null, after: makeItem({ projectId }) }],
            });
        markProcessed();

        const plain = env.service.revert(make());

        assert.equal(plain.reprocessed, 0);
        assert.notEqual(getSession(env.store, "pi", "s1")?.processedRevision, null);

        const again = env.service.revert(make(), { reprocess: true });

        assert.equal(again.reprocessed, 1);
        assert.equal(getSession(env.store, "pi", "s1")?.processedRevision, null);
        assert.ok(listEvents(env.store, "pi", "s1").every((event) => event.processedHash === null));
    });

    it("reverts an agent note by deleting it", () => {
        const note = env.service.noteWrite({ title: "Oops", body: "Wrong.", cwd: repo });
        assert.ok(note.createdRun);

        env.service.revert(note.createdRun);

        assert.equal(getItem(env.store, note.id), null);
    });

    it("rejects an unknown run, a run that is not ok and a run kind that cannot be undone", () => {
        const running = startRun(env.store, { kind: "project", trigger: "test" });
        const forgetRun = startRun(env.store, { kind: "forget", trigger: "test" });
        env.store.run("UPDATE runs SET status = 'ok' WHERE id = ?", forgetRun);

        assert.throws(() => env.service.revert(9999), MemoryOperationError);
        assert.throws(() => env.service.revert(running), /not ok/u);
        assert.throws(() => env.service.revert(forgetRun), /cannot be reverted/u);
    });
});

describe("revert after a project split or merge", () => {
    const remote = "https://example.invalid/org/shared.git";

    it("keeps a restored item in the project that a split moved it to", () => {
        const cloneA = createRepo(env.folder("clone-a"), { remote });
        const cloneB = createRepo(env.folder("clone-b"), { remote });
        env.writePiSession({
            id: "s-a",
            cwd: cloneA,
            messages: [{ role: "user", text: "from a" }],
        });
        env.writePiSession({
            id: "s-b",
            cwd: cloneB,
            messages: [{ role: "user", text: "from b" }],
        });
        env.importNow();
        const shared = env.service.resolver.resolve(cloneA)?.projectId;
        assert.ok(shared);
        const [event] = listEvents(env.store, "pi", "s-a");
        assert.ok(event);
        const source: SourceRef = {
            kind: "event",
            harness: "pi",
            sessionId: "s-a",
            eventKey: event.key,
        };
        const item = makeItem({ projectId: shared, title: "Before", sources: [source] });
        commitRun(env.store, { projectId: shared, changes: [{ before: null, after: item }] });
        const runId = commitRun(env.store, {
            projectId: shared,
            changes: [{ before: item, after: { ...item, title: "After" } }],
        });
        const commonDir = env.service
            .projects()
            .flatMap((project) => project.locators)
            .find((l) => l.kind === "git_common_dir" && l.value.includes("clone-a"));
        assert.ok(commonDir);
        const split = env.service.split("git_common_dir", commonDir.value, "Clone A");
        assert.equal(getItem(env.store, item.id)?.projectId, split.project.id);

        env.service.revert(runId);

        const restored = getItem(env.store, item.id);
        assert.equal(restored?.title, "Before");
        assert.equal(restored?.projectId, split.project.id);
    });

    it("puts a restored item whose project was merged away into the live project", () => {
        const other = createRepo(env.folder("other"));
        const target = env.service.resolver.resolve(other)?.projectId;
        assert.ok(target);
        const item = makeItem({ projectId, title: "Before" });
        commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });
        const runId = commitRun(env.store, {
            projectId,
            changes: [{ before: item, after: { ...item, title: "After" } }],
        });
        deleteItem(env.store, item.id);
        env.service.merge(projectId, target);

        env.service.revert(runId);

        const restored = getItem(env.store, item.id);
        assert.equal(restored?.title, "Before");
        assert.equal(restored?.projectId, target);
    });
});

describe("forget", () => {
    function importTwoSessions(): { eventA: SourceRef; eventB: SourceRef; pathA: string } {
        const pathA = env.writePiSession({
            id: "sa",
            cwd: repo,
            messages: [{ role: "user", text: "Unique zebra phrase about caching." }],
        });
        env.writePiSession({
            id: "sb",
            cwd: repo,
            messages: [{ role: "user", text: "Second session about logging." }],
        });
        env.importNow();
        const keyA = listEvents(env.store, "pi", "sa")[0]?.key;
        const keyB = listEvents(env.store, "pi", "sb")[0]?.key;
        assert.ok(keyA && keyB);
        return {
            pathA,
            eventA: { kind: "event", harness: "pi", sessionId: "sa", eventKey: keyA },
            eventB: { kind: "event", harness: "pi", sessionId: "sb", eventKey: keyB },
        };
    }

    it("deletes the session, its events and its transcript", () => {
        const { pathA } = importTwoSessions();
        const transcript = getSession(env.store, "pi", "sa")?.transcriptPath;
        assert.ok(transcript && existsSync(transcript));
        assert.equal(env.service.search({ query: "zebra" }).hits.length, 1);

        const result = env.service.forget("pi", "sa");

        assert.equal(result.sessionId, "sa");
        assert.equal(getSession(env.store, "pi", "sa"), null);
        assert.equal(listEvents(env.store, "pi", "sa").length, 0);
        assert.ok(!existsSync(transcript));
        assert.equal(env.service.search({ query: "zebra" }).hits.length, 0);
        assert.ok(getSession(env.store, "pi", "sb"));
        assert.ok(existsSync(pathA));
        const run = getRun(env.store, result.runId);
        assert.equal(run?.kind, "forget");
        assert.deepEqual(run?.sessions, ["pi:sa"]);
    });

    it("retires items that only the forgotten session supported and keeps shared ones", () => {
        const { eventA, eventB } = importTwoSessions();
        const only = makeItem({ projectId, title: "Only A", sources: [eventA] });
        const shared = makeItem({ projectId, title: "Shared", sources: [eventA, eventB] });
        const other = makeItem({ projectId, title: "Only B", sources: [eventB] });
        commitRun(env.store, {
            projectId,
            changes: [only, shared, other].map((after) => ({ before: null, after })),
        });
        env.service.regenerate();
        assert.equal(notePage(only.id).length, 1);

        const result = env.service.forget("pi", "sa");

        assert.deepEqual([result.retired, result.updated], [1, 1]);
        assert.equal(getItem(env.store, only.id)?.status, "retired");
        assert.deepEqual(getItem(env.store, only.id)?.sources, []);
        const kept = getItem(env.store, shared.id);
        assert.equal(kept?.status, "active");
        assert.deepEqual(kept?.sources, [eventB]);
        assert.equal(getItem(env.store, other.id)?.status, "active");
        assert.equal(notePage(only.id).length, 0);
        assert.equal(notePage(shared.id).length, 1);
        const history = env.store.get(
            "SELECT COUNT(*) AS n FROM item_history WHERE item_id = ?",
            only.id,
        );
        assert.equal(history?.n, 2);
    });

    it("retires an agent note that the forgotten session wrote", () => {
        importTwoSessions();
        const note = env.service.noteWrite({
            title: "From A",
            body: "Claim.",
            cwd: repo,
            writerHarness: "pi",
            writerSession: "sa",
        });

        const result = env.service.forget("pi", "sa");

        assert.equal(result.retired, 1);
        assert.equal(getItem(env.store, note.id)?.status, "retired");
    });

    it("does not import the forgotten session again, even after its file changes", () => {
        const { pathA } = importTwoSessions();
        env.service.forget("pi", "sa");

        env.importNow();
        env.writePiSession({
            id: "sa",
            cwd: repo,
            messages: [{ role: "user", text: "Changed after forgetting." }],
        });
        const summary = env.importNow();

        assert.equal(getSession(env.store, "pi", "sa"), null);
        assert.ok(summary.skipped >= 1);
        assert.ok(existsSync(pathA));
    });

    it("rejects a session that does not exist", () => {
        assert.throws(() => env.service.forget("pi", "missing"), MemoryOperationError);
    });
});
