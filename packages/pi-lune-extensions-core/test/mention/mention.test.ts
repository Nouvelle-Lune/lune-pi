import assert from "node:assert/strict";
import { test } from "node:test";
import {
    fileReference,
    findMentions,
    mentionToken,
    replaceMentions,
    resolveMention,
    shortSessionId,
} from "../../src/mention/mention.ts";
import {
    cleanBody,
    cleanLine,
    clip,
    formatAge,
    projectName,
    sessionTitle,
} from "../../src/mention/text.ts";
import { sessionInfo } from "../harness/session-fixtures.ts";

const ID_A = "01a14931-31bb-7000-8000-aaaaaaaaaaaa";
const ID_B = "01a14931-31bb-7000-8000-bbbbbbbbbbbb";

test("findMentions matches tokens at the start, after whitespace and after wrappers", () => {
    const actual = findMentions(`@session:${ID_A} and (@session:abc123) then "@session:def456"`);
    assert.deepEqual(
        actual.map((mention) => mention.idPrefix),
        [ID_A, "abc123", "def456"],
    );
});

test("findMentions accepts a token after CJK punctuation", () => {
    const actual = findMentions("参考（@session:01a14931-31bb）和，@session:ffff0000aaaa。");
    assert.deepEqual(
        actual.map((mention) => mention.idPrefix),
        ["01a14931-31bb", "ffff0000aaaa"],
    );
});

test("findMentions ignores a token glued to a word and keeps a trailing period out of the id", () => {
    assert.deepEqual(findMentions("not@session:abc123def456"), []);
    const actual = findMentions("see @session:abc123def456.");
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.idPrefix, "abc123def456");
    assert.equal(actual[0]!.token, "@session:abc123def456");
    assert.equal(actual[0]!.index, 4);
});

test("shortSessionId returns the 13-character id prefix when it is unique", () => {
    const other = "01b24931-31bb-7000-8000-cccccccccccc";
    const sessions = [sessionInfo({ id: ID_A }), sessionInfo({ id: other })];
    assert.equal(shortSessionId(ID_A, sessions), ID_A.slice(0, 13));
});

test("shortSessionId extends the prefix until it no longer matches another session", () => {
    const sessions = [sessionInfo({ id: ID_A }), sessionInfo({ id: ID_B })];
    // The ids share their first 28 characters ("...-8000-"), so the prefix must reach the
    // first differing character.
    const actual = shortSessionId(ID_A, sessions);
    const expected = ID_A.slice(0, ID_A.indexOf("aaaa") + 1);
    assert.equal(actual, expected);
});

test("shortSessionId never ends a prefix on a separator", () => {
    const first = "abcdefghijkl-m1";
    const second = "abcdefghijkl-m2";
    const sessions = [sessionInfo({ id: first }), sessionInfo({ id: second })];
    assert.equal(shortSessionId(first, sessions), first);
    const withDash = [sessionInfo({ id: "abcdefghijkl-1" }), sessionInfo({ id: "abcdefghijkl-2" })];
    // Length 13 would be "abcdefghijkl-", which ends in "-", so it is skipped; the full id is
    // the shortest valid answer.
    assert.equal(shortSessionId("abcdefghijkl-1", withDash), "abcdefghijkl-1");
});

test("mentionToken prefixes the short id with @session:", () => {
    const sessions = [sessionInfo({ id: ID_A })];
    assert.equal(mentionToken(sessions[0]!, sessions), `@session:${ID_A.slice(0, 13)}`);
});

test("resolveMention returns the single matching session", () => {
    const sessions = [sessionInfo({ id: ID_A }), sessionInfo({ id: "ffff0000-0000-7000-8000-0" })];
    assert.equal(resolveMention("01a14931", sessions).id, ID_A);
});

test("resolveMention reports different errors for no match and for several matches", () => {
    const sessions = [sessionInfo({ id: ID_A }), sessionInfo({ id: ID_B })];
    assert.throws(() => resolveMention("zzzz", sessions), /No local session matches @session:zzzz/);
    assert.throws(
        () => resolveMention("01a14931", sessions),
        /@session:01a14931 matches 2 sessions; type more of the id/,
    );
});

test("replaceMentions swaps only the mention tokens and keeps the surrounding text", () => {
    const text = "a @session:abc123def456 b（@session:fff000aaa111）c";
    const actual = replaceMentions(text, findMentions(text), (mention) => `<${mention.idPrefix}>`);
    assert.equal(actual, "a <abc123def456> b（<fff000aaa111>）c");
});

test("fileReference quotes a path only when it contains whitespace", () => {
    assert.equal(fileReference("/tmp/a.md"), "@/tmp/a.md");
    assert.equal(fileReference("/tmp/my dir/a.md"), '@"/tmp/my dir/a.md"');
});

test("clip truncates by code point and reports how many characters were cut", () => {
    assert.equal(clip("abc", 3), "abc");
    assert.equal(clip("😀😀😀😀", 2), "😀😀 … [2 more characters]");
    assert.equal(clip("你好世界", 3), "你好世 … [1 more characters]");
});

test("cleanBody strips terminal sequences and control characters but keeps newlines", () => {
    const actual = cleanBody("\x1b[31mred\x1b[0m\x07a\u0000b\n\n\n\nend\ttab");
    assert.equal(actual, "red a b\n\nend\ttab");
});

test("cleanLine collapses all whitespace into single spaces", () => {
    assert.equal(cleanLine("  a\n\nb \t c  "), "a b c");
});

test("sessionTitle prefers the name, then the first message, then the id", () => {
    assert.equal(sessionTitle(sessionInfo({ name: "Named", firstMessage: "first" })), "Named");
    assert.equal(sessionTitle(sessionInfo({ firstMessage: "first\nline" })), "first line");
    assert.equal(sessionTitle(sessionInfo({ id: "the-id", firstMessage: "" })), "the-id");
});

test("projectName is the last path segment of the working directory", () => {
    assert.equal(projectName(sessionInfo({ cwd: "/a/b/my-project" })), "my-project");
    assert.equal(projectName(sessionInfo({ cwd: "" })), "unknown project");
});

test("formatAge picks the compact unit for each age range", () => {
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const actual = [
        formatAge(30_000),
        formatAge(12 * minute),
        formatAge(5 * hour),
        formatAge(13 * day),
        formatAge(14 * day),
        formatAge(60 * day),
        formatAge(800 * day),
    ];
    assert.deepEqual(actual, ["now", "12m", "5h", "13d", "2w", "8w", "2y"]);
});
