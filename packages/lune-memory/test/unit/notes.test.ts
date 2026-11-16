import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { EventRow, Item, ItemKind } from "../../src/core/types.ts";
import { clampTrust } from "../../src/dreaming/evidence.ts";
import { retractNote, updateNote, writeNote } from "../../src/memory/notes.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { Store } from "../../src/store/db.ts";
import { getItem, getRun } from "../../src/store/rows.ts";
import { createRepo } from "../harness/memory.ts";

let root: string;
let store: Store;
let resolver: ProjectResolver;
let repo: string;

before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lune-memory-test-")));
    store = Store.open(":memory:");
    resolver = new ProjectResolver(store);
    repo = createRepo(join(root, "repo"));
});

after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
});

const writer = { harness: "pi", session: "s-1" } as const;

function write(overrides: Partial<Parameters<typeof writeNote>[2]> = {}): Item {
    return writeNote(store, resolver, {
        title: "A note",
        body: "Body text.",
        writerHarness: "pi",
        writerSession: "s-1",
        ...overrides,
    });
}

// Assembled at runtime so no literal credential sits in the source.
const fakeSecret = `sk-${"ant-"}${"a1B2c3D4".repeat(4)}`;

describe("writeNote", () => {
    it("stores a provisional agent note with inference trust and a recorded run", () => {
        const item = write({ cwd: repo });

        const stored = getItem(store, item.id);
        assert.equal(stored?.status, "provisional");
        assert.equal(stored?.origin, "agent_note");
        assert.equal(stored?.trust, "inference");
        assert.equal(stored?.kind, "note");
        assert.equal(stored?.scope, "project");
        assert.equal(stored?.branch, "main");
        assert.equal(stored?.writerSession, "s-1");
        const run = item.createdRun === null ? null : getRun(store, item.createdRun);
        assert.equal(run?.kind, "note");
        assert.equal(run?.status, "ok");
    });

    it("makes a global candidate note when the cwd is outside any project", () => {
        const item = write({ cwd: join(root, "nowhere") });

        assert.equal(item.scope, "global");
        assert.equal(item.projectId, null);
        assert.equal(item.status, "provisional");
    });

    it("normalizes the title and keeps the given kind", () => {
        const item = write({ title: "  Many \n  spaces  ", kind: "lesson" });

        assert.equal(item.title, "Many spaces");
        assert.equal(item.kind, "lesson");
    });

    it("calls onCommit once with the stored note", () => {
        const seen: Item[] = [];

        const item = writeNote(
            store,
            resolver,
            { title: "Hook", body: "b" },
            { onCommit: (committed) => seen.push(committed) },
        );

        assert.deepEqual(seen, [item]);
    });

    for (const kind of ["index", "wiki", "working_state"] as ItemKind[]) {
        it(`rejects the reserved kind ${kind}`, () => {
            assert.throws(() => write({ kind }), /cannot have kind/u);
        });
    }

    it("rejects empty and oversized text", () => {
        assert.throws(() => write({ title: "   " }), /needs a title/u);
        assert.throws(() => write({ body: "\n " }), /needs a body/u);
        assert.throws(() => write({ title: "t".repeat(201) }), /at most 200/u);
        assert.throws(() => write({ body: "b".repeat(20_001) }), /at most 20000/u);
    });

    it("redacts secrets from the title and body before storing", () => {
        const item = write({
            title: `Key ${fakeSecret} rotated`,
            body: `Use ${fakeSecret} for the build.`,
        });

        const stored = getItem(store, item.id);
        assert.equal(stored?.title, "Key [redacted] rotated");
        assert.equal(stored?.body, "Use [redacted] for the build.");
        assert.ok(!`${stored?.title}${stored?.body}`.includes(fakeSecret));
    });
});

describe("updateNote and retractNote", () => {
    it("redacts secrets from the new title and body", () => {
        const item = write();

        updateNote(store, item.id, {
            ...writer,
            title: `Key ${fakeSecret} rotated`,
            body: `Use ${fakeSecret} for the build.`,
        });

        const stored = getItem(store, item.id);
        assert.equal(stored?.title, "Key [redacted] rotated");
        assert.equal(stored?.body, "Use [redacted] for the build.");
        assert.ok(!`${stored?.title}${stored?.body}`.includes(fakeSecret));
    });

    it("lets the writer replace the text of a provisional note", () => {
        const item = write();

        const updated = updateNote(store, item.id, { ...writer, title: "New", body: "New body." });

        assert.equal(updated.title, "New");
        assert.equal(updated.body, "New body.");
        assert.equal(updated.status, "provisional");
        assert.notEqual(updated.contentHash, item.contentHash);
        assert.equal(getItem(store, item.id)?.body, "New body.");
    });

    it("refuses an update from another session or another harness", () => {
        const item = write();

        assert.throws(
            () =>
                updateNote(store, item.id, {
                    harness: "pi",
                    session: "s-2",
                    title: "x",
                    body: "y",
                }),
            /Only the session that wrote/u,
        );
        assert.throws(
            () =>
                updateNote(store, item.id, {
                    harness: "claude",
                    session: "s-1",
                    title: "x",
                    body: "y",
                }),
            /Only the session that wrote/u,
        );
        assert.equal(getItem(store, item.id)?.body, "Body text.");
    });

    it("refuses to update a note that Dreaming reviewed", () => {
        const item = write();
        store.run("UPDATE items SET status = 'active' WHERE id = ?", item.id);

        assert.throws(
            () => updateNote(store, item.id, { ...writer, title: "x", body: "y" }),
            /was reviewed/u,
        );
    });

    it("retires a note for its writer and then refuses any further change", () => {
        const item = write();

        const retired = retractNote(store, item.id, writer);

        assert.equal(retired.status, "retired");
        assert.equal(getItem(store, item.id)?.status, "retired");
        assert.throws(() => retractNote(store, item.id, writer), /is retired/u);
        assert.throws(
            () => updateNote(store, item.id, { ...writer, title: "x", body: "y" }),
            /is retired/u,
        );
    });

    it("refuses a retraction by another session", () => {
        const item = write();

        assert.throws(
            () => retractNote(store, item.id, { harness: "pi", session: "other" }),
            /Only the session that wrote/u,
        );
        assert.equal(getItem(store, item.id)?.status, "provisional");
    });

    it("treats an unknown id and a Dreaming item as unknown notes", () => {
        const item = write();
        store.run("UPDATE items SET origin = 'dreaming' WHERE id = ?", item.id);

        assert.throws(() => retractNote(store, "n-missing", writer), /Unknown note/u);
        assert.throws(() => retractNote(store, item.id, writer), /Unknown note/u);
    });
});

describe("evidence clamps trust", () => {
    function event(role: EventRow["role"], untrusted = false): EventRow {
        return {
            harness: "pi",
            sessionId: "s",
            key: `${role}-${untrusted}`,
            seq: 0,
            role,
            toolName: null,
            text: "x",
            time: null,
            sourceLine: null,
            transcriptLine: null,
            memoryDerived: false,
            untrusted,
            active: true,
            hash: "h",
            processedHash: null,
        };
    }

    it("keeps user trust only when a trusted user event supports it", () => {
        assert.equal(clampTrust("user", [event("user")], "decision"), "user");
        assert.equal(clampTrust("user", [event("assistant")], "decision"), "inference");
        assert.equal(clampTrust("user", [event("tool_result", true)], "decision"), "tool");
        assert.equal(clampTrust("user", [event("user", true)], "decision"), "tool");
    });

    it("never raises a claim above what it claimed", () => {
        assert.equal(clampTrust("inference", [event("user")], "decision"), "inference");
    });

    it("gives no more than inference without evidence, and never tool trust to a preference", () => {
        assert.equal(clampTrust("user", [], "fact"), "inference");
        assert.equal(clampTrust("tool", [event("tool_result", true)], "preference"), "inference");
    });
});
