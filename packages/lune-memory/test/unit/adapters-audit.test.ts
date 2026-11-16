import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { claudeAdapter } from "../../src/adapters/claude.ts";
import { codexAdapter, recordKeys } from "../../src/adapters/codex.ts";
import { findJsonlFiles } from "../../src/adapters/common.ts";
import { piAdapter } from "../../src/adapters/pi.ts";
import { AdapterFormatError } from "../../src/adapters/types.ts";
import {
    claudeRecord,
    codexMessage,
    codexMeta,
    jsonl,
    makeTempDir,
    piHeader,
    piMessage,
    removeDir,
    writeText,
} from "../harness/ingest.ts";

let dir: string;
beforeEach(() => {
    dir = makeTempDir();
});
afterEach(() => removeDir(dir));

const UNKNOWN_FORMAT = /unknown format/u;

describe("an unknown content shape throws instead of dropping the event", () => {
    const shapes: Array<[string, unknown]> = [
        ["a number", 42],
        ["an object", { text: "x" }],
        ["null", null],
    ];

    for (const [name, content] of shapes) {
        it(`Claude: user content as ${name}`, () => {
            const text = jsonl([claudeRecord("s", "u1", null, "user", content)]);
            assert.throws(() => claudeAdapter.parse("/p/proj/s.jsonl", text), UNKNOWN_FORMAT);
        });

        it(`Claude: assistant content as ${name}`, () => {
            const text = jsonl([
                claudeRecord("s", "u1", null, "user", "hi"),
                claudeRecord("s", "a1", "u1", "assistant", content),
            ]);
            assert.throws(() => claudeAdapter.parse("/p/proj/s.jsonl", text), UNKNOWN_FORMAT);
        });

        it(`Codex: user content as ${name}`, () => {
            const text = jsonl([
                codexMeta("c1", "/w"),
                {
                    type: "response_item",
                    payload: { type: "message", role: "user", content },
                },
            ]);
            assert.throws(() => codexAdapter.parse("/p/rollout-x.jsonl", text), UNKNOWN_FORMAT);
        });

        it(`Codex: assistant content as ${name}`, () => {
            const text = jsonl([
                codexMeta("c1", "/w"),
                {
                    type: "response_item",
                    payload: { type: "message", role: "assistant", content },
                },
            ]);
            assert.throws(() => codexAdapter.parse("/p/rollout-x.jsonl", text), UNKNOWN_FORMAT);
        });

        it(`Pi: user content as ${name}`, () => {
            const text = jsonl([piHeader("s1", "/w"), piMessage("m1", null, "user", content)]);
            assert.throws(() => piAdapter.parse("/p/cwd/s1.jsonl", text), UNKNOWN_FORMAT);
        });

        it(`Pi: assistant content as ${name}`, () => {
            const text = jsonl([
                piHeader("s1", "/w"),
                piMessage("m1", null, "user", "hi"),
                piMessage("m2", "m1", "assistant", content),
            ]);
            assert.throws(() => piAdapter.parse("/p/cwd/s1.jsonl", text), UNKNOWN_FORMAT);
        });
    }

    it("throws an AdapterFormatError that the importer can record on the session", () => {
        const text = jsonl([claudeRecord("s", "u1", null, "user", 42)]);
        assert.throws(() => claudeAdapter.parse("/p/proj/s.jsonl", text), AdapterFormatError);
    });

    it("still reads a string and an array of blocks", () => {
        const claude = claudeAdapter.parse(
            "/p/proj/s.jsonl",
            jsonl([
                claudeRecord("s", "u1", null, "user", "as string"),
                claudeRecord("s", "a1", "u1", "assistant", [{ type: "text", text: "as array" }]),
            ]),
        );
        const pi = piAdapter.parse(
            "/p/cwd/s1.jsonl",
            jsonl([
                piHeader("s1", "/w"),
                piMessage("m1", null, "user", "as string"),
                piMessage("m2", "m1", "assistant", "plain assistant string"),
            ]),
        );

        assert.deepEqual(
            claude?.events.map((event) => event.text),
            ["as string", "as array"],
        );
        assert.deepEqual(
            pi?.events.map((event) => event.text),
            ["as string", "plain assistant string"],
        );
    });
});

describe("Codex record keys", () => {
    it("gives a record a key from its raw line, with a count for repeated lines", () => {
        const keys = recordKeys([{ raw: "a" }, { raw: "b" }, { raw: "a" }, { raw: "a" }]);

        assert.equal(keys.length, 4);
        assert.equal(new Set(keys).size, 4);
        const first = keys[0] ?? "";
        assert.equal(keys[2], `${first}.1`);
        assert.equal(keys[3], `${first}.2`);
        assert.doesNotMatch(first, /\./u);
    });

    it("does not depend on the position of a record", () => {
        const before = recordKeys([{ raw: "x" }, { raw: "y" }]);
        const after = recordKeys([{ raw: "w" }, { raw: "x" }, { raw: "y" }]);

        assert.equal(after[1], before[0]);
        assert.equal(after[2], before[1]);
    });

    it("keeps the event keys after a record is inserted into the rollout", () => {
        const head = codexMeta("c1", "/w");
        const original = codexAdapter.parse(
            "/p/rollout-x.jsonl",
            jsonl([head, codexMessage("user", "one"), codexMessage("assistant", "two")]),
        );
        const rewritten = codexAdapter.parse(
            "/p/rollout-x.jsonl",
            jsonl([
                head,
                codexMessage("user", "inserted"),
                codexMessage("user", "one"),
                codexMessage("assistant", "two"),
            ]),
        );

        const keyOf = (evidence: typeof original, text: string) =>
            evidence?.events.find((event) => event.text === text)?.key;
        assert.ok(keyOf(original, "one"));
        assert.equal(keyOf(rewritten, "one"), keyOf(original, "one"));
        assert.equal(keyOf(rewritten, "two"), keyOf(original, "two"));
        assert.notEqual(keyOf(rewritten, "inserted"), keyOf(rewritten, "one"));
    });

    it("gives two identical messages different keys", () => {
        const actual = codexAdapter.parse(
            "/p/rollout-x.jsonl",
            jsonl([
                codexMeta("c1", "/w"),
                codexMessage("user", "same"),
                codexMessage("user", "same"),
            ]),
        );

        const keys = actual?.events.map((event) => event.key) ?? [];
        assert.equal(keys.length, 2);
        assert.equal(new Set(keys).size, 2);
    });
});

describe("Claude chain order", () => {
    const texts = (text: string) =>
        claudeAdapter.parse("/p/proj/s.jsonl", text)?.events.map((event) => event.text);

    it("orders events along the parent chain when a child comes before its parent in the file", () => {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "first"),
            claudeRecord("s", "u3", "a2", "user", "third"),
            claudeRecord("s", "a2", "u1", "assistant", [{ type: "text", text: "second" }]),
        ]);

        assert.deepEqual(texts(text), ["first", "second", "third"]);
    });

    it("keeps the file order for a file that is already in chain order", () => {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "first"),
            claudeRecord("s", "a2", "u1", "assistant", [{ type: "text", text: "second" }]),
            claudeRecord("s", "u3", "a2", "user", "third"),
        ]);

        assert.deepEqual(texts(text), ["first", "second", "third"]);
    });

    it("keeps the parts of one record in order", () => {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "first"),
            claudeRecord("s", "a2", "u1", "assistant", [
                { type: "text", text: "part one" },
                { type: "text", text: "part two" },
            ]),
        ]);

        assert.deepEqual(texts(text), ["first", "part one", "part two"]);
    });

    it("does not loop and keeps every event for a parent cycle off the active path", () => {
        const text = jsonl([
            claudeRecord("s", "x", "y", "user", "cycle x"),
            claudeRecord("s", "y", "x", "assistant", [{ type: "text", text: "cycle y" }]),
            claudeRecord("s", "r1", null, "user", "root"),
            claudeRecord("s", "r2", "r1", "assistant", [{ type: "text", text: "leaf" }]),
        ]);

        const actual = claudeAdapter.parse("/p/proj/s.jsonl", text);

        assert.deepEqual(actual?.events.map((event) => [event.text, event.active]).sort(), [
            ["cycle x", false],
            ["cycle y", false],
            ["leaf", true],
            ["root", true],
        ]);
    });

    it("reports a parent cycle on the active path as a format error", () => {
        const text = jsonl([
            claudeRecord("s", "x", "y", "user", "cycle x"),
            claudeRecord("s", "y", "x", "assistant", [{ type: "text", text: "cycle y" }]),
        ]);

        assert.throws(
            () => claudeAdapter.parse("/p/proj/s.jsonl", text),
            (error: Error) => {
                assert.ok(error instanceof AdapterFormatError);
                assert.match(error.message, /parent chain has a cycle/u);
                return true;
            },
        );
    });
});

describe("Claude active leaf", () => {
    const flags = (records: unknown[]) =>
        Object.fromEntries(
            (claudeAdapter.parse("/p/proj/s.jsonl", jsonl(records))?.events ?? []).map((event) => [
                event.text,
                event.active,
            ]),
        );
    const reply = (uuid: string, parent: string, text: string) =>
        claudeRecord("s", uuid, parent, "assistant", [{ type: "text", text }]);

    it("keeps all events active when a child comes before its parent in the file", () => {
        const actual = flags([
            claudeRecord("s", "u1", null, "user", "first"),
            claudeRecord("s", "u3", "a2", "user", "third"),
            reply("a2", "u1", "second"),
        ]);

        assert.deepEqual(actual, { first: true, second: true, third: true });
    });

    it("marks the old branch abandoned after a rewind from an earlier parent", () => {
        const actual = flags([
            claudeRecord("s", "u1", null, "user", "first"),
            reply("a2", "u1", "second"),
            claudeRecord("s", "u3", "a2", "user", "old branch"),
            claudeRecord("s", "u4", "a2", "user", "edited"),
            reply("a5", "u4", "reply"),
        ]);

        assert.deepEqual(actual, {
            first: true,
            second: true,
            "old branch": false,
            edited: true,
            reply: true,
        });
    });

    it("lets the later record in the file win when two leaves have the same place", () => {
        // Both children come before their parent, so they get the same chain place.
        const actual = flags([
            claudeRecord("s", "u1", null, "user", "first"),
            claudeRecord("s", "c1", "p", "user", "earlier child"),
            claudeRecord("s", "c2", "p", "user", "later child"),
            reply("p", "u1", "parent"),
        ]);

        assert.deepEqual(actual, {
            first: true,
            parent: true,
            "earlier child": false,
            "later child": true,
        });
    });
});

describe("findJsonlFiles symlinks", () => {
    function setup() {
        const root = join(dir, "root");
        const outside = join(dir, "outside");
        writeText(join(root, "real", "in.jsonl"), "{}\n");
        writeText(join(outside, "out.jsonl"), "{}\n");
        mkdirSync(join(root, "links"), { recursive: true });
        return { root, outside };
    }

    it("skips a symlink to a directory outside the root", () => {
        const { root, outside } = setup();
        symlinkSync(outside, join(root, "links", "dir-out"));

        const actual = findJsonlFiles("pi", root, 3).map((ref) => ref.path);

        assert.deepEqual(actual, [join(root, "real", "in.jsonl")]);
    });

    it("skips a symlink to a file outside the root", () => {
        const { root, outside } = setup();
        symlinkSync(join(outside, "out.jsonl"), join(root, "links", "file-out.jsonl"));

        const actual = findJsonlFiles("pi", root, 3).map((ref) => ref.path);

        assert.deepEqual(actual, [join(root, "real", "in.jsonl")]);
    });

    it("follows a symlink to a directory and to a file inside the root", () => {
        const { root } = setup();
        symlinkSync(join(root, "real"), join(root, "links", "dir-in"));
        symlinkSync(join(root, "real", "in.jsonl"), join(root, "links", "file-in.jsonl"));

        const actual = findJsonlFiles("pi", root, 3)
            .map((ref) => ref.path)
            .sort();

        assert.deepEqual(
            actual,
            [
                join(root, "links", "dir-in", "in.jsonl"),
                join(root, "links", "file-in.jsonl"),
                join(root, "real", "in.jsonl"),
            ].sort(),
        );
    });

    it("follows a symlink whose path leaves and re-enters the root", () => {
        // The link target is inside the root once resolved, so it is followed, not skipped.
        const { root } = setup();
        symlinkSync(join(root, "..", "root", "real"), join(root, "links", "dotdot"));

        const actual = findJsonlFiles("pi", root, 3).map((ref) => ref.path);

        assert.ok(actual.includes(join(root, "links", "dotdot", "in.jsonl")));
    });

    it("accepts a root that is itself reached through a symlink", () => {
        const { root } = setup();
        const alias = join(dir, "alias");
        symlinkSync(root, alias);

        const actual = findJsonlFiles("pi", alias, 3).map((ref) => ref.path);

        assert.deepEqual(actual, [join(alias, "real", "in.jsonl")]);
    });

    it("skips a broken symlink without throwing", () => {
        const { root } = setup();
        symlinkSync(join(dir, "nowhere"), join(root, "links", "broken.jsonl"));

        const actual = findJsonlFiles("pi", root, 3).map((ref) => ref.path);

        assert.deepEqual(actual, [join(root, "real", "in.jsonl")]);
    });
});
