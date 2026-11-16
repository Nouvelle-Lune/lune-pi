import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    asBody,
    errorStatus,
    optInt,
    parseDream,
    parseHarnessList,
    parseL1,
    parseNoteUpdate,
    parseNoteWrite,
    parseSearch,
    parseWriter,
    reqHarness,
    RequestError,
    searchArguments,
} from "../../src/api/requests.ts";
import { MemoryOperationError } from "../../src/core/errors.ts";

function rejects(run: () => unknown, message: RegExp): void {
    assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.status, 400);
        assert.match(error.message, message);
        return true;
    });
}

describe("asBody", () => {
    it("treats a missing body as empty and rejects non-objects", () => {
        assert.deepEqual(asBody(undefined), {});
        assert.deepEqual(asBody(null), {});
        rejects(() => asBody([]), /JSON object/u);
        rejects(() => asBody("text"), /JSON object/u);
    });
});

describe("parseNoteWrite", () => {
    it("requires a title and a body", () => {
        rejects(() => parseNoteWrite({ body: "b" }), /title must be a non-empty string/u);
        rejects(
            () => parseNoteWrite({ title: "t", body: "  " }),
            /body must be a non-empty string/u,
        );
    });

    it("rejects unknown kind, trust and malformed sources", () => {
        rejects(
            () => parseNoteWrite({ title: "t", body: "b", kind: "poem" }),
            /kind must be one of/u,
        );
        rejects(() => parseNoteWrite({ title: "t", body: "b", trust: "root" }), /trust must be/u);
        rejects(
            () => parseNoteWrite({ title: "t", body: "b", sources: "x" }),
            /sources must be a list/u,
        );
        rejects(
            () => parseNoteWrite({ title: "t", body: "b", sources: [{ kind: "other" }] }),
            /kind event or item/u,
        );
        rejects(
            () =>
                parseNoteWrite({
                    title: "t",
                    body: "b",
                    sources: Array.from({ length: 51 }, () => ({ kind: "item", itemId: "i" })),
                }),
            /at most 50 sources/u,
        );
    });

    it("keeps only the given fields and parses sources", () => {
        const actual = parseNoteWrite({
            title: "t",
            body: "b",
            trust: "user",
            writerHarness: "codex",
            sources: [
                { kind: "item", itemId: "i-1" },
                { kind: "event", harness: "pi", sessionId: "s", eventKey: "e" },
            ],
        });
        const expected = {
            title: "t",
            body: "b",
            trust: "user",
            writerHarness: "codex",
            sources: [
                { kind: "item", itemId: "i-1" },
                { kind: "event", harness: "pi", sessionId: "s", eventKey: "e" },
            ],
        };
        assert.deepEqual(actual, expected);
    });
});

describe("other parsers", () => {
    it("parseNoteUpdate and parseWriter read the writer identity", () => {
        assert.deepEqual(parseWriter({}), { harness: null, session: null });
        const actual = parseNoteUpdate({ title: "t", body: "b", harness: "claude", session: "s" });
        assert.deepEqual(actual, { title: "t", body: "b", harness: "claude", session: "s" });
        rejects(() => parseWriter({ harness: "vim" }), /harness must be pi, claude or codex/u);
        rejects(() => parseNoteUpdate({ title: "t" }), /body must be/u);
    });

    it("parseSearch checks types and ranges", () => {
        rejects(() => parseSearch({}), /query must be/u);
        rejects(
            () => parseSearch({ query: "q", limit: 51 }),
            /limit must be an integer from 1 to 50/u,
        );
        rejects(
            () => parseSearch({ query: "q", context: 1.5 }),
            /context must be an integer from 0 to 5/u,
        );
        rejects(
            () => parseSearch({ query: "q", allProjects: "yes" }),
            /allProjects must be true or false/u,
        );
        assert.deepEqual(parseSearch({ query: "q", limit: 3, context: 0 }), {
            query: "q",
            limit: 3,
            context: 0,
        });
    });

    it("searchArguments turns allProjects into a null project filter", () => {
        const actual = searchArguments({ query: "q", allProjects: true, cwd: "/x" });
        assert.deepEqual(actual, { query: "q", cwd: "/x", projectId: null });
        assert.deepEqual(searchArguments({ query: "q" }), { query: "q" });
    });

    it("parseL1 defaults to nulls", () => {
        assert.deepEqual(parseL1({}), { cwd: null, harness: null, sessionId: null });
        rejects(() => parseL1({ announceSession: "no" }), /announceSession must be/u);
    });

    it("parseDream is manual and checks the session list", () => {
        assert.deepEqual(parseDream({}), { trigger: "manual", force: false });
        assert.deepEqual(parseDream({ force: true, projectId: "p", sessions: ["a"] }), {
            trigger: "manual",
            force: true,
            projectId: "p",
            sessions: ["a"],
        });
        rejects(() => parseDream({ sessions: [1] }), /sessions must be a list of strings/u);
    });

    it("parseHarnessList rejects unknown harnesses", () => {
        assert.equal(parseHarnessList({}), undefined);
        assert.deepEqual(parseHarnessList({ harnesses: ["pi", "codex"] }), ["pi", "codex"]);
        rejects(() => parseHarnessList({ harnesses: ["emacs"] }), /Unknown harness: emacs/u);
    });

    it("reqHarness and optInt enforce their ranges", () => {
        rejects(() => reqHarness({}, "harness"), /harness must be/u);
        assert.equal(optInt({ n: 5 }, "n", 1, 5), 5);
        rejects(() => optInt({ n: 6 }, "n", 1, 5), /n must be an integer from 1 to 5/u);
    });
});

describe("errorStatus", () => {
    it("maps request and operation errors and answers 500 for plain errors", () => {
        assert.equal(errorStatus(new RequestError("x", 503)), 503);
        assert.equal(errorStatus(new MemoryOperationError("Unknown project: p")), 404);
        assert.equal(errorStatus(new MemoryOperationError("Note n-1 not found")), 404);
        assert.equal(errorStatus(new MemoryOperationError("A note needs a title")), 400);
        assert.equal(errorStatus(new Error("Unknown project: p")), 500);
        assert.equal(errorStatus(new TypeError("boom")), 500);
        assert.equal(errorStatus("string"), 500);
    });
});
