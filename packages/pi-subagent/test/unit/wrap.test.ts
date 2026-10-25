import assert from "node:assert/strict";
import { test } from "node:test";

import { headRows, LineWrapCache, tailRows } from "../../src/inspector/wrap.ts";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("headRows returns the first rows and counts the lines left out", () => {
    const actual = headRows(["a", "b", "c", "d", "e"], 10, 3);

    assert.deepEqual(actual, { rows: ["a", "b", "c"], hidden: 2 });
});

test("headRows hides nothing when everything fits", () => {
    assert.deepEqual(headRows(["a", "b"], 10, 3), { rows: ["a", "b"], hidden: 0 });
    assert.deepEqual(headRows([], 10, 3), { rows: [], hidden: 0 });
});

test("headRows counts wrapped rows against the limit and counts a line shown in part as hidden", () => {
    const actual = headRows(["x".repeat(25), "next"], 10, 2);

    assert.deepEqual(actual, { rows: ["x".repeat(10), "x".repeat(10)], hidden: 2 });
});

test("tailRows returns the last rows and counts the lines left out", () => {
    const actual = tailRows(["a", "b", "c", "d", "e"], 10, 3);

    assert.deepEqual(actual, { rows: ["c", "d", "e"], hidden: 2 });
});

test("tailRows hides nothing when everything fits", () => {
    assert.deepEqual(tailRows(["a", "b"], 10, 3), { rows: ["a", "b"], hidden: 0 });
    assert.deepEqual(tailRows([], 10, 3), { rows: [], hidden: 0 });
});

test("tailRows keeps the end of a line that wraps past the limit", () => {
    const actual = tailRows(["head", `${"a".repeat(10)}${"b".repeat(10)}${"c".repeat(10)}`], 10, 2);

    assert.deepEqual(actual, { rows: ["b".repeat(10), "c".repeat(10)], hidden: 2 });
});

test("a huge line costs a bounded number of rows and counts as hidden", () => {
    const line = "z".repeat(5_000_000);
    const head = headRows([line], 10, 3);
    const tail = tailRows([line], 10, 3);

    assert.equal(head.rows.length, 3);
    assert.equal(head.hidden, 1);
    assert.deepEqual(tail.rows, ["z".repeat(10), "z".repeat(10), "z".repeat(10)]);
    assert.equal(tail.hidden, 1);
});

test("cutting a long line never splits a surrogate pair", () => {
    // The bound is (3 + 1) * 10 * 2 = 80 characters; the head cut falls inside a pair here.
    const head = headRows([`a${"\u{1f600}".repeat(100)}`], 10, 3);
    // The tail cut falls inside a pair here.
    const tail = tailRows([`${"\u{1f600}".repeat(100)}a`], 10, 3);

    for (const row of [...head.rows, ...tail.rows]) {
        assert.doesNotMatch(row, LONE_SURROGATE);
    }

    assert.ok(head.rows.length > 0 && tail.rows.length > 0);
});

test("LineWrapCache wraps a line to the width", () => {
    const cache = new LineWrapCache();

    assert.deepEqual(cache.rows("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("LineWrapCache returns the cached rows for the same line and width", () => {
    const cache = new LineWrapCache();
    const first = cache.rows("abcdefghij", 4);

    assert.equal(cache.rows("abcdefghij", 4), first);
});

test("LineWrapCache keeps rows per width", () => {
    const cache = new LineWrapCache();

    assert.deepEqual(cache.rows("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    assert.deepEqual(cache.rows("abcdefghij", 5), ["abcde", "fghij"]);
    assert.deepEqual(cache.rows("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("LineWrapCache.clear forgets cached rows", () => {
    const cache = new LineWrapCache();
    const first = cache.rows("abcdefghij", 4);

    cache.clear();

    const second = cache.rows("abcdefghij", 4);

    assert.notEqual(second, first);
    assert.deepEqual(second, first);
});
