import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { queryTerms, transcriptSearch, type SearchOptions } from "../../src/memory/search.ts";
import { Store } from "../../src/store/db.ts";
import { seedSession } from "../harness/memory.ts";

let store: Store;

beforeEach(() => {
    store = Store.open(":memory:");
});

afterEach(() => {
    store.close();
});

describe("queryTerms", () => {
    it("splits on spaces, keeps quoted phrases whole and drops duplicates", () => {
        const actual = queryTerms('alpha "two words" alpha beta');

        assert.deepEqual(actual, ["alpha", "two words", "beta"]);
    });
});

describe("transcriptSearch", () => {
    it("finds a substring inside a word with the trigram index and ranks the hit", () => {
        seedSession(store, {
            id: "s1",
            projectId: "p-1",
            title: "Cocktails",
            events: [{ text: "We talked about the mocktail recipe." }, { text: "Unrelated text." }],
        });

        const result = transcriptSearch(store, { query: "ocktail" });

        assert.equal(result.hits.length, 1);
        const hit = result.hits[0];
        assert.ok(hit);
        assert.equal(hit.sessionId, "s1");
        assert.equal(hit.seq, 0);
        assert.equal(hit.excerpt, "We talked about the mocktail recipe.");
        assert.equal(hit.title, "Cocktails");
        assert.equal(hit.projectId, "p-1");
        assert.equal(typeof hit.rank, "number");
        assert.equal(hit.sourceLine, 2);
        assert.equal(result.limited, false);
    });

    it("returns the neighbouring events and none with context 0", () => {
        seedSession(store, {
            id: "s1",
            events: [{ text: "before one" }, { text: "needle here" }, { text: "after one" }],
        });

        const near = transcriptSearch(store, { query: "needle" }).hits[0];
        const alone = transcriptSearch(store, { query: "needle", context: 0 }).hits[0];

        assert.deepEqual(
            near?.before.map((event) => event.text),
            ["before one"],
        );
        assert.deepEqual(
            near?.after.map((event) => event.text),
            ["after one"],
        );
        assert.deepEqual([alone?.before.length, alone?.after.length], [0, 0]);
    });

    it("matches a term shorter than three characters as an escaped substring", () => {
        seedSession(store, {
            id: "s1",
            events: [{ text: "it grew 5% fast" }, { text: "it grew 55 fast" }],
        });

        const result = transcriptSearch(store, { query: "5%" });

        assert.deepEqual(
            result.hits.map((hit) => hit.excerpt),
            ["it grew 5% fast"],
        );
        assert.equal(result.hits[0]?.rank, null);
    });

    it("requires every term to match the same event", () => {
        seedSession(store, {
            id: "s1",
            events: [{ text: "apple banana" }, { text: "apple only" }],
        });

        const result = transcriptSearch(store, { query: "apple banana" });

        assert.deepEqual(
            result.hits.map((hit) => hit.seq),
            [0],
        );
    });

    it("leaves out memory-derived events unless asked", () => {
        seedSession(store, {
            id: "s1",
            events: [
                { text: "secret phrase from the user" },
                { text: "secret phrase injected by memory", memoryDerived: true },
            ],
        });

        const plain = transcriptSearch(store, { query: "secret phrase" });
        const all = transcriptSearch(store, { query: "secret phrase", includeMemoryDerived: true });

        assert.deepEqual(
            plain.hits.map((hit) => hit.memoryDerived),
            [false],
        );
        assert.equal(all.hits.length, 2);
    });

    it("filters by project, harness, session and time", () => {
        seedSession(store, {
            id: "a",
            projectId: "p-1",
            events: [{ text: "shared words", time: "2026-01-01T00:00:00.000Z" }],
        });
        seedSession(store, {
            id: "b",
            projectId: "p-2",
            events: [{ text: "shared words", time: "2026-03-01T00:00:00.000Z" }],
        });
        seedSession(store, {
            id: "c",
            harness: "claude",
            projectId: "p-2",
            events: [{ text: "shared words", time: "2026-05-01T00:00:00.000Z" }],
        });
        const ids = (options: Omit<SearchOptions, "query">): string[] =>
            transcriptSearch(store, { query: "shared words", ...options })
                .hits.map((hit) => hit.sessionId)
                .sort();

        assert.deepEqual(ids({}), ["a", "b", "c"]);
        assert.deepEqual(ids({ projectId: "p-2" }), ["b", "c"]);
        assert.deepEqual(ids({ harness: "claude" }), ["c"]);
        assert.deepEqual(ids({ sessionId: "a" }), ["a"]);
        assert.deepEqual(ids({ since: "2026-02-01T00:00:00Z" }), ["b", "c"]);
        assert.deepEqual(ids({ until: "2026-04-01T00:00:00Z" }), ["a", "b"]);
    });

    it("follows a merged project when filtering by its old id", () => {
        store.run(
            "INSERT INTO projects(id, name, root, merged_into, created_at) VALUES ('p-old', 'old', NULL, 'p-new', 'x'), ('p-new', 'new', NULL, NULL, 'x')",
        );
        seedSession(store, { id: "a", projectId: "p-new", events: [{ text: "findable words" }] });

        const result = transcriptSearch(store, { query: "findable", projectId: "p-old" });

        assert.equal(result.hits.length, 1);
    });

    it("stops at the limit and says more hits can exist", () => {
        seedSession(store, {
            id: "s1",
            events: [{ text: "repeat one" }, { text: "repeat two" }, { text: "repeat three" }],
        });

        const result = transcriptSearch(store, { query: "repeat", limit: 2 });

        assert.equal(result.hits.length, 2);
        assert.equal(result.limited, true);
    });

    it("gives a verbatim window around the match in a long event", () => {
        const body = `${"a".repeat(1500)} NEEDLE ${"b".repeat(1500)}`;
        seedSession(store, { id: "s1", events: [{ text: body }] });

        const hit = transcriptSearch(store, { query: "needle" }).hits[0];

        assert.ok(hit);
        assert.equal(hit.excerpt, body.slice(hit.excerptStart, hit.excerptEnd));
        assert.ok(hit.excerpt.includes("NEEDLE"));
        assert.ok(hit.excerpt.length < body.length);
        assert.equal(hit.textLength, body.length);
    });

    it("keeps events of deleted sessions out of the index", () => {
        seedSession(store, { id: "s1", events: [{ text: "ephemeral content" }] });
        store.run("DELETE FROM sessions WHERE id = 's1'");

        const result = transcriptSearch(store, { query: "ephemeral" });

        assert.equal(result.hits.length, 0);
    });

    it("rejects an empty query and a bad time", () => {
        assert.throws(() => transcriptSearch(store, { query: "   " }), /query is empty/u);
        assert.throws(
            () => transcriptSearch(store, { query: "abc", since: "not a time" }),
            /not a valid time/u,
        );
    });
});
