import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { projectViewPaths } from "../../src/core/paths.ts";
import { projectionStale } from "../../src/memory/projection.ts";
import type { ServiceEvent } from "../../src/service.ts";
import { getItem, getRun, getSession } from "../../src/store/rows.ts";
import {
    commitRun,
    createMemoryEnv,
    createRepo,
    makeItem,
    type MemoryEnv,
} from "../harness/memory.ts";

const WRITER = { writerHarness: "pi", writerSession: "w1" } as const;

let env: MemoryEnv;
let repo: string;
let projectId: string;
let events: ServiceEvent[];

beforeEach(async () => {
    env = await createMemoryEnv();
    repo = createRepo(env.folder("app"));
    const resolution = env.service.resolver.resolve(repo);
    assert.ok(resolution);
    projectId = resolution.projectId;
    events = [];
    env.service.on((event) => events.push(event));
});

afterEach(() => {
    env.cleanup();
});

/**
 * Make every view write fail: a file takes the place of the generations folder, so no
 * generation can be created. It needs no file permissions, so it also works as root.
 */
function breakViews(): void {
    rmSync(env.service.paths.generations, { recursive: true, force: true });
    writeFileSync(env.service.paths.generations, "not a directory");
}

/** Undo `breakViews`, so that the next view write can succeed. */
function fixViews(): void {
    rmSync(env.service.paths.generations, { force: true });
}

function notePages(): string[] {
    const dir = projectViewPaths(env.service.paths, projectId).notes;
    return existsSync(dir) ? readdirSync(dir) : [];
}

describe("notes with a failing view write", () => {
    it("noteWrite returns projectionError and keeps the note in the database", () => {
        env.service.regenerate();
        breakViews();

        const note = env.service.noteWrite({ title: "Kept", body: "Saved anyway.", cwd: repo });

        assert.ok(note.projectionError);
        assert.equal(getItem(env.store, note.id)?.title, "Kept");
    });

    it("noteUpdate and noteRetract return projectionError and keep their change", () => {
        const note = env.service.noteWrite({
            title: "Before",
            body: "Body.",
            cwd: repo,
            ...WRITER,
        });
        assert.equal(note.projectionError, undefined);
        breakViews();

        const updated = env.service.noteUpdate(note.id, {
            title: "After",
            body: "Changed.",
            harness: "pi",
            session: "w1",
        });
        const retracted = env.service.noteRetract(note.id, { harness: "pi", session: "w1" });

        assert.ok(updated.projectionError);
        assert.ok(retracted.projectionError);
        assert.equal(getItem(env.store, note.id)?.title, "After");
        assert.equal(getItem(env.store, note.id)?.status, "retired");
    });

    it("emits the error on the index event", () => {
        env.service.regenerate();
        breakViews();

        const note = env.service.noteWrite({ title: "Event", body: "Body.", cwd: repo });

        const index = events.filter((event) => event.type === "index").at(-1);
        assert.equal(
            (index?.data as { projectionError?: string } | undefined)?.projectionError,
            note.projectionError,
        );
    });

    it("returns no projectionError when the views are written", () => {
        const note = env.service.noteWrite({ title: "Fine", body: "Body.", cwd: repo });

        assert.equal(note.projectionError, undefined);
        assert.equal(projectionStale(env.store), null);
    });
});

describe("the stale mark", () => {
    it("is set by a failed write with the error, and not set by a good one", () => {
        assert.equal(projectionStale(env.store), null);
        env.service.regenerate();
        breakViews();

        const note = env.service.noteWrite({ title: "A", body: "Body.", cwd: repo });

        assert.equal(env.store.getMeta("projection_stale"), note.projectionError);
        assert.equal(projectionStale(env.store), note.projectionError);
    });

    it("stays after another failed regeneration", () => {
        env.service.regenerate();
        breakViews();
        env.service.noteWrite({ title: "A", body: "Body.", cwd: repo });

        assert.throws(() => env.service.regenerate());

        assert.ok(projectionStale(env.store));
    });

    it("is cleared only after a successful full regeneration", () => {
        env.service.regenerate();
        breakViews();
        env.service.noteWrite({ title: "A", body: "Body.", cwd: repo });
        fixViews();
        assert.ok(projectionStale(env.store));

        env.service.regenerate();

        assert.equal(projectionStale(env.store), null);
    });

    it("makes the next projectItem write all items, not only its own", () => {
        env.service.regenerate();
        breakViews();
        const missed = env.service.noteWrite({ title: "Missed", body: "Body.", cwd: repo });
        fixViews();
        assert.ok(projectionStale(env.store));

        const next = env.service.noteWrite({ title: "Next", body: "Body.", cwd: repo });

        assert.equal(next.projectionError, undefined);
        assert.equal(projectionStale(env.store), null);
        const pages = notePages();
        assert.equal(pages.filter((name) => name.includes(missed.id)).length, 1);
        assert.equal(pages.filter((name) => name.includes(next.id)).length, 1);
    });
});

describe("repairViews and status", () => {
    it("repairViews returns null and writes nothing when the views are not stale", () => {
        env.service.regenerate();
        const before = readdirSync(env.service.paths.generations);

        const actual = env.service.repairViews();

        assert.equal(actual, null);
        assert.deepEqual(readdirSync(env.service.paths.generations), before);
    });

    it("repairViews regenerates when stale and clears the mark", () => {
        env.service.regenerate();
        breakViews();
        const note = env.service.noteWrite({ title: "Later", body: "Body.", cwd: repo });
        fixViews();

        const actual = env.service.repairViews();

        assert.equal(actual, null);
        assert.equal(projectionStale(env.store), null);
        assert.equal(notePages().filter((name) => name.includes(note.id)).length, 1);
    });

    it("repairViews returns the error when the regeneration fails, and the mark stays", () => {
        env.service.regenerate();
        breakViews();
        env.service.noteWrite({ title: "Later", body: "Body.", cwd: repo });

        const actual = env.service.repairViews();

        assert.equal(typeof actual, "string");
        assert.ok(actual);
        assert.equal(projectionStale(env.store), actual);
        const index = events.filter((event) => event.type === "index").at(-1);
        assert.equal((index?.data as { projectionError?: string }).projectionError, actual);
    });

    it("status shows viewsError while stale and null when the views are fine", () => {
        env.service.regenerate();
        assert.equal(env.service.status().viewsError, null);
        breakViews();
        const note = env.service.noteWrite({ title: "A", body: "Body.", cwd: repo });

        assert.equal(env.service.status().viewsError, note.projectionError);

        fixViews();
        env.service.repairViews();
        assert.equal(env.service.status().viewsError, null);
    });
});

describe("revert and forget with a failing view write", () => {
    it("revert returns projectionError and the revert is done", () => {
        const item = makeItem({ projectId, title: "Created" });
        const runId = commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });
        env.service.regenerate();
        breakViews();

        const result = env.service.revert(runId);

        assert.ok(result.projectionError);
        assert.equal(getItem(env.store, item.id), null);
        assert.equal(getRun(env.store, runId)?.status, "reverted");
        assert.ok(projectionStale(env.store));
    });

    it("revert returns no projectionError when the views are written", () => {
        const item = makeItem({ projectId, title: "Created" });
        const runId = commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });

        const result = env.service.revert(runId);

        assert.equal("projectionError" in result, false);
    });

    it("forget returns projectionError and the session is gone", () => {
        env.writePiSession({ id: "sa", cwd: repo, messages: [{ role: "user", text: "Hello." }] });
        env.importNow();
        assert.ok(getSession(env.store, "pi", "sa"));
        env.service.regenerate();
        breakViews();

        const result = env.service.forget("pi", "sa");

        assert.ok(result.projectionError);
        assert.equal(getSession(env.store, "pi", "sa"), null);
        assert.ok(projectionStale(env.store));
    });

    it("forget returns no projectionError when the views are written", () => {
        env.writePiSession({ id: "sa", cwd: repo, messages: [{ role: "user", text: "Hello." }] });
        env.importNow();

        const result = env.service.forget("pi", "sa");

        assert.equal("projectionError" in result, false);
        assert.equal(projectionStale(env.store), null);
    });
});
