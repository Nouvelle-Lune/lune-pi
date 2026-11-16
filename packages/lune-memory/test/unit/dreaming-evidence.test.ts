import assert from "node:assert/strict";
import test from "node:test";

import type { EventRow } from "../../src/core/types.ts";
import { statesGeneral, statesRetraction } from "../../src/dreaming/evidence.ts";

function user(text: string): EventRow {
    return {
        harness: "claude",
        sessionId: "s",
        key: "k",
        seq: 1,
        role: "user",
        toolName: null,
        text,
        time: null,
        sourceLine: null,
        transcriptLine: null,
        memoryDerived: false,
        untrusted: false,
        active: true,
        hash: "h",
        processedHash: null,
        processedChars: null,
    };
}

const ENGLISH = ["Answer in English", "Reply in English in every project."];

test("a statement that names one service sets a scoped rule, not a general one", () => {
    assert.equal(statesGeneral(user("For this service, always answer in English.")), false);
});

test("a statement about all of the user's projects is general, in English and Chinese", () => {
    assert.equal(statesGeneral(user("Across all of my projects, reply in Chinese.")), true);
    assert.equal(statesGeneral(user("所有项目都用中文回复。")), true);
});

test("a statement from a tool or an assistant is never general", () => {
    assert.equal(statesGeneral({ ...user("Always answer in English."), role: "assistant" }), false);
    assert.equal(statesGeneral({ ...user("Always answer in English."), untrusted: true }), false);
});

test("a retraction of another topic does not retire an English preference", () => {
    assert.equal(statesRetraction(user("Stop using tabs."), ENGLISH), false);
});

test("a retraction about the preference's own topic can retire it", () => {
    assert.equal(
        statesRetraction(user("Stop answering in English; use Chinese instead."), ENGLISH),
        true,
    );
});

test("a withdrawing clause about another topic inside a rule-setting statement does not retire the English preference", () => {
    assert.equal(
        statesRetraction(user("Always answer in English, and don't use tabs."), ENGLISH),
        false,
    );
});

test("a reminder such as `don't forget` does not withdraw a rule", () => {
    assert.equal(statesRetraction(user("Don't forget to answer in English."), ENGLISH), false);
    assert.equal(statesRetraction(user("别忘了用英文回答。"), ["用英文回答"]), false);
});

test("a statement that names one project is an exception, not a retraction", () => {
    assert.equal(
        statesRetraction(user("In this project, stop answering in English."), ENGLISH),
        false,
    );
});

test("without a preference text any withdrawing statement counts as a retraction", () => {
    assert.equal(statesRetraction(user("Stop using tabs.")), true);
});
