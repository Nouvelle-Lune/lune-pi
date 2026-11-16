import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { Importer } from "../../src/ingest/importer.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { getItem, getSession, listEvents, listItems } from "../../src/store/rows.ts";
import {
    analyzerReply,
    createDreamEnv,
    createOp,
    decisionCandidate,
    HOUR,
    NOW,
    type DreamEnv,
} from "../harness/dreaming.ts";
import { fileRef, jsonl, piHeader, piMessage, writeText } from "../harness/ingest.ts";
import { createRepo } from "../harness/memory.ts";

const REMOTE = "https://example.invalid/org/repo.git";

interface Clones {
    a: string;
    b: string;
    /** Project that both clones resolve to before a split. */
    old: string;
    resolver: ProjectResolver;
}

/** Two clones of one remote. They share a project and have separate locators. */
function sharedClones(env: DreamEnv): Clones {
    const a = createRepo(join(env.home, "clone-a"), { remote: REMOTE });
    const b = createRepo(join(env.home, "clone-b"), { remote: REMOTE });
    const resolver = new ProjectResolver(env.store);
    const old = resolver.resolve(a)?.projectId ?? "";
    assert.notEqual(old, "");
    assert.equal(resolver.resolve(b)?.projectId, old);
    return { a, b, old, resolver };
}

function writePi(path: string, id: string, cwd: string, text: string | null): void {
    const records: unknown[] = [piHeader(id, cwd)];
    if (text !== null) records.push(piMessage(`${id}-m1`, null, "user", text));
    writeText(path, jsonl(records));
}

test("a split during the Analyzer does not commit to the old project, and its moved Note is reviewed on the retry", async (t) => {
    const env = createDreamEnv(t);
    const { a, old, resolver } = sharedClones(env);
    env.addSession({
        id: "s1",
        projectId: old,
        events: [{ role: "user", text: "We use WAL mode." }],
    });
    env.store.run("UPDATE sessions SET cwd = ? WHERE harness = 'claude' AND id = 's1'", a);
    env.addItem({
        id: "pending-note",
        projectId: old,
        kind: "note",
        title: "Use WAL",
        body: "We use WAL mode.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "s1",
    });
    let target = "";
    const noteReview = {
        noteId: "pending-note",
        action: "keep",
        title: null,
        body: null,
        evidence: ["e1"],
        reason: "supported",
    };
    env.route({
        analyzer: () => {
            if (!target) target = resolver.split("git_common_dir", join(a, ".git")).project.id;
            return {
                ...analyzerReply([decisionCandidate("Use WAL")]),
                noteReviews: [noteReview],
            };
        },
        organizer: { summary: "one", ops: [createOp("Use WAL", ["s1.c1"])] },
    });

    const first = await env.pass({ force: true });

    assert.equal(first.projects[0]?.counts?.created ?? 0, 0);
    assert.equal(listItems(env.store, { scope: "project", projectId: old }).length, 0);
    const moved = getSession(env.store, "claude", "s1");
    assert.equal(moved?.projectId, target);
    assert.equal(moved?.processedRevision ?? null, null);
    const pending = getItem(env.store, "pending-note");
    assert.equal(pending?.projectId, target);
    assert.equal(pending?.status, "provisional");

    await env.pass({ force: true });

    const created = listItems(env.store, {
        scope: "project",
        projectId: target,
        kind: ["decision"],
        status: ["active"],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.title, "Use WAL");
    assert.equal(getItem(env.store, "pending-note")?.status, "active");
    const processed = getSession(env.store, "claude", "s1");
    assert.equal(processed?.processedRevision, processed?.revision);
});

test("a merge during the Analyzer does not commit to the merged-away project", async (t) => {
    const env = createDreamEnv(t);
    const resolver = new ProjectResolver(env.store);
    env.addProject("p1", "One");
    env.addProject("p2", "Two");
    env.addSession({
        id: "s1",
        projectId: "p1",
        events: [{ role: "user", text: "We use WAL mode." }],
    });
    let merged = false;
    env.route({
        analyzer: () => {
            if (!merged) {
                merged = true;
                resolver.merge("p1", "p2");
            }
            return analyzerReply([decisionCandidate("Use WAL")]);
        },
        organizer: { summary: "one", ops: [createOp("Use WAL", ["s1.c1"])] },
    });

    const first = await env.pass({ force: true });

    assert.equal(first.projects[0]?.counts?.created ?? 0, 0);
    assert.equal(listItems(env.store, { scope: "project", projectId: "p1" }).length, 0);
    assert.equal(getSession(env.store, "claude", "s1")?.projectId, "p2");
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision ?? null, null);

    await env.pass({ force: true });

    const created = listItems(env.store, {
        scope: "project",
        projectId: "p2",
        kind: ["decision"],
        status: ["active"],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.title, "Use WAL");
    const processed = getSession(env.store, "claude", "s1");
    assert.equal(processed?.processedRevision, processed?.revision);
});

test("a split keeps a deleted source of the old project in the moved session's review", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.historyDays = 0;
    const { a, b, old, resolver } = sharedClones(env);
    const importer = new Importer(env.store, env.paths, env.config, resolver, {
        now: () => NOW - 10 * HOUR,
    });
    const pathA = join(env.home, "sa.jsonl");
    const pathB = join(env.home, "sb.jsonl");
    writePi(pathA, "sa", a, "The service uses SQLite.");
    writePi(pathB, "sb", b, "Hello, unrelated context.");
    assert.equal(importer.importFile(fileRef("pi", pathA)).outcome, "imported");
    assert.equal(importer.importFile(fileRef("pi", pathB)).outcome, "imported");
    env.store.run("UPDATE events SET processed_hash = hash WHERE harness = 'pi'");
    env.store.run("UPDATE sessions SET processed_revision = revision WHERE harness = 'pi'");
    const [eventA] = listEvents(env.store, "pi", "sa");
    const [eventB] = listEvents(env.store, "pi", "sb");
    assert.ok(eventA);
    assert.ok(eventB);
    const sourceA = {
        kind: "event" as const,
        harness: "pi" as const,
        sessionId: "sa",
        eventKey: eventA.key,
    };
    const sourceB = {
        kind: "event" as const,
        harness: "pi" as const,
        sessionId: "sb",
        eventKey: eventB.key,
    };
    env.addItem({
        id: "mixed",
        projectId: old,
        kind: "decision",
        title: "Use SQLite",
        body: "The service uses SQLite.",
        sources: [sourceA, sourceB],
    });
    const split = resolver.split("git_common_dir", join(a, ".git"));
    assert.equal(getSession(env.store, "pi", "sa")?.projectId, split.project.id);
    assert.equal(getItem(env.store, "mixed")?.projectId, old);

    // The moved session loses its only event, so the item that stays keeps a dead source.
    writePi(pathA, "sa", a, null);
    assert.equal(importer.importFile(fileRef("pi", pathA)).outcome, "imported");
    const queued = getSession(env.store, "pi", "sa");
    assert.equal(queued?.reviewRevision, queued?.revision);

    env.route({ analyzer: analyzerReply([]), organizer: { summary: "", ops: [] } });
    const summary = await env.pass({ force: true, sessions: ["pi:sa"] });

    assert.equal(summary.eligible, 1);
    assert.equal(summary.trivial, 0);
    const item = getItem(env.store, "mixed");
    assert.equal(item?.status, "active");
    assert.deepEqual(item?.sources, [sourceB]);
    assert.equal(getSession(env.store, "pi", "sa")?.reviewRevision ?? null, null);
});
