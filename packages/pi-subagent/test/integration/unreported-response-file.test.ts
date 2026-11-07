import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import type { RunManager } from "../../src/run/run-manager.ts";
import { createSubagentTools } from "../../src/tools/subagent-tools.ts";
import { createFixture, reportResponse, textResponse, waitForTurns } from "../harness/fixture.ts";

const LIMIT = 20_000;

interface TempIsolation {
    root: string;
    tempRoot: string;
}

/**
 * Points `os.tmpdir()` at a fresh folder so response files never reach the real temp directory.
 * Created after the fixture, whose session files then stay outside `tempRoot`.
 */
function isolateTemp(t: TestContext, subdirectory = "tmp"): TempIsolation {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-responses-")));
    const tempRoot = join(root, subdirectory);
    const names = ["TMPDIR", "TMP", "TEMP"] as const;
    const previous = names.map((name) => process.env[name]);

    for (const name of names) {
        process.env[name] = tempRoot;
    }

    t.after(() => {
        names.forEach((name, index) => {
            const value = previous[index];

            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        });
        rmSync(root, { recursive: true, force: true });
    });

    return { root, tempRoot };
}

function longReply(length: number, marker: string): string {
    const tail = `\n${marker}`;

    return `${"x".repeat(length - tail.length)}${tail}`;
}

function quotedResponseFile(text: string): string {
    const match = /full response: "([^"]+)"/.exec(text);

    assert.ok(match, "The text does not quote a full response file.");

    return match[1]!;
}

function responseFiles(tempRoot: string): string[] {
    if (!existsSync(tempRoot)) {
        return [];
    }

    return readdirSync(tempRoot, { recursive: true, encoding: "utf8" })
        .map((entry) => join(tempRoot, entry))
        .filter((entry) => entry.endsWith(".md") && statSync(entry).isFile())
        .sort();
}

async function statusText(
    manager: RunManager,
    ctx: ExtensionToolContext,
    runId: string,
): Promise<string> {
    const tools = createSubagentTools({
        manager,
        definitions: [],
        models: [],
        autoOnly: true,
        catalog: { tools: [], errors: [] },
    });
    const status = tools.find((tool) => tool.name === "subagent_status");

    assert.ok(status, "The subagent tools do not include subagent_status");

    const result = await status.execute("status-1", { runId }, undefined, () => undefined, ctx);

    return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

test("a reply over the limit writes the whole text to a readable file named in the notice and status", async (t) => {
    const fx = await createFixture(t);
    const isolated = isolateTemp(t, "temp directory");
    const manager = fx.createManager();
    const fullText = longReply(LIMIT + 5_000, "tail: the whole reply");
    const expected = fullText;
    const omission = "[5000 more characters in the run transcript; full response:";

    fx.faux.setResponses([textResponse(fullText)]);

    const run = await manager.start({ task: "write a long answer" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);
    const notice = String(sent!.message.content);
    const noticeFile = quotedResponseFile(notice);

    assert.equal(run.lastTurn?.unreportedMessage?.slice(0, LIMIT), fullText.slice(0, LIMIT));
    assert.ok(run.lastTurn?.unreportedMessage?.includes(omission));
    assert.equal(
        notice.includes(fullText.slice(0, LIMIT)),
        true,
        "The notice dropped the truncated prefix.",
    );

    assert.equal(isAbsolute(noticeFile), true);
    assert.ok(
        noticeFile.startsWith(`${isolated.tempRoot}${sep}`),
        `The response file ${noticeFile} is outside ${isolated.tempRoot}.`,
    );
    assert.notEqual(dirname(noticeFile), isolated.tempRoot, "The file is not in a subdirectory.");
    assert.equal(noticeFile.endsWith(".md"), true);
    assert.equal(statSync(noticeFile).mode & 0o777, 0o600);

    const actual = readFileSync(noticeFile, "utf8");

    assert.equal(actual, expected);
    assert.deepEqual(responseFiles(isolated.tempRoot), [noticeFile]);

    assert.equal(notice.includes("tail: the whole reply"), false);

    const status = await statusText(manager, fx.ctx as ExtensionToolContext, run.id);

    assert.ok(status.includes(noticeFile), "subagent_status does not name the response file.");
    assert.ok(status.includes(omission));
    assert.equal(status.includes("tail: the whole reply"), false);
});

test("a reply at the limit and a long report write no response file", async (t) => {
    const fx = await createFixture(t);
    const isolated = isolateTemp(t);
    const manager = fx.createManager();
    const atLimit = "y".repeat(LIMIT);
    const longSummary = longReply(LIMIT + 5_000, "tail: the long report");

    fx.faux.setResponses([textResponse(atLimit)]);

    const unreported = await manager.start({ task: "at the limit" }, fx.ctx);

    await waitForTurns(manager, unreported, 1);

    const [atLimitNotice] = await fx.pi.waitForMessages(1);

    assert.equal(unreported.lastTurn?.unreportedMessage, atLimit);

    fx.faux.setResponses([reportResponse("done", longSummary)]);

    const reported = await manager.start({ task: "a long report" }, fx.ctx);

    await waitForTurns(manager, reported, 1);

    const notices = await fx.pi.waitForMessages(2);

    assert.equal(reported.lastTurn?.report?.summary, longSummary);
    assert.deepEqual(responseFiles(isolated.tempRoot), []);
    assert.doesNotMatch(String(atLimitNotice!.message.content), /full response/);
    assert.doesNotMatch(String(notices[1]!.message.content), /full response/);
});

test("a later long reply in the same run leaves the earlier response file untouched", async (t) => {
    const fx = await createFixture(t);
    const isolated = isolateTemp(t);
    const manager = fx.createManager();
    const firstReply = longReply(LIMIT + 1_000, "tail: the first turn");
    const secondReply = longReply(LIMIT + 9_000, "tail: the second turn");

    fx.faux.setResponses([textResponse(firstReply)]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    const [firstSent] = await fx.pi.waitForMessages(1);
    const firstFile = quotedResponseFile(String(firstSent!.message.content));

    fx.faux.setResponses([textResponse(secondReply)]);
    await manager.send(run, "one more thing", "main-agent");
    await waitForTurns(manager, run, 2);

    const notices = await fx.pi.waitForMessages(2);
    const secondFile = quotedResponseFile(String(notices[1]!.message.content));

    assert.notEqual(secondFile, firstFile);
    assert.deepEqual(responseFiles(isolated.tempRoot), [firstFile, secondFile].sort());
    assert.equal(readFileSync(firstFile, "utf8"), firstReply);
    assert.equal(readFileSync(secondFile, "utf8"), secondReply);
});

test("an unwritable response file leaves the turn settled with an error diagnostic", async (t) => {
    const fx = await createFixture(t);
    const isolated = isolateTemp(t, join("not-a-directory", "tmp"));
    const manager = fx.createManager();
    const fullText = longReply(LIMIT + 5_000, "tail: the whole reply");
    const unavailable =
        "[5000 more characters in the run transcript; full response file unavailable: ";

    writeFileSync(join(isolated.root, "not-a-directory"), "not a directory");

    fx.faux.setResponses([textResponse(fullText)]);

    const run = await manager.start({ task: "write a long answer" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);
    const notice = String(sent!.message.content);
    const record = run.lastTurn?.unreportedMessage ?? "";

    assert.equal(run.state, "idle");
    assert.equal(run.turns, 1);
    assert.equal(record.slice(0, LIMIT), fullText.slice(0, LIMIT));
    assert.ok(
        record.includes(unavailable),
        `The record has no unavailable-file hint (${record.length} chars).`,
    );
    assert.equal(record.includes('full response: "'), false);
    assert.ok(notice.includes("full response file unavailable"));
    assert.equal(notice.includes("tail: the whole reply"), false);

    const errors = run.diagnostics.filter((diagnostic) => diagnostic.level === "error");

    assert.equal(errors.length > 0, true, "The failed write left no error diagnostic.");

    const diagnostic = errors.find((entry) => /full response/i.test(entry.message));

    assert.ok(diagnostic, `No diagnostic names the response file: ${errors.map((e) => e.message)}`);

    const status = await statusText(manager, fx.ctx as ExtensionToolContext, run.id);

    assert.ok(status.includes(diagnostic.message));
    assert.deepEqual(responseFiles(isolated.tempRoot), []);
});
