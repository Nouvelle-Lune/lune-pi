import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { TranscriptRenderer } from "../../src/inspector/transcript.ts";
import type { Run } from "../../src/run/run.ts";
import { assistantMessage, fakeTheme, restoredRun, tempAgentDir, userMessage } from "./support.ts";

type Part = Record<string, unknown>;

function assistant(parts: Part[], extra: Record<string, unknown> = {}): AgentMessage {
    return {
        ...(assistantMessage("") as object),
        content: parts,
        ...extra,
    } as unknown as AgentMessage;
}

function call(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    extra: Part = {},
): Part {
    return { type: "toolCall", id, name, arguments: args, ...extra };
}

function result(
    id: string,
    text: string,
    extra: { isError?: boolean; durationMs?: number; details?: unknown } = {},
): AgentMessage {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: "tool",
        content: [{ type: "text", text }],
        isError: extra.isError ?? false,
        durationMs: extra.durationMs,
        details: extra.details,
        timestamp: 3,
    } as unknown as AgentMessage;
}

function lines(count: number, prefix = "line"): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

/** A restored run whose transcript is `messages`, with the live fields a test sets directly. */
function runOf(t: TestContext, messages: AgentMessage[]): Run {
    return restoredRun(tempAgentDir(t), "r1", { messages });
}

function render(run: Run, width = 80): string[] {
    return [...new TranscriptRenderer(fakeTheme()).render(run, width)];
}

// Tool calls

test("a finished call is one row with its icon, name, summary and duration", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "read", { path: "src/a.ts" })]),
        result("t1", "FILE BODY", { durationMs: 1500 }),
    ]);

    assert.deepEqual(render(run), ["● read src/a.ts · 1.5s"]);
});

test("a finished call with a diff shows the added and removed lines as a stat", (t) => {
    const diff = "+one\n+two\n-three\n unchanged";
    const run = runOf(t, [
        assistant([call("t1", "edit", { path: "a.ts" })]),
        result("t1", "ok", { durationMs: 300, details: { diff } }),
    ]);

    assert.deepEqual(render(run), ["● edit a.ts · +2 −1 · 0.3s"]);
});

test("a call without a result that is not running shows as not finished", (t) => {
    const run = runOf(t, [assistant([call("t1", "read", { path: "a.ts" })])]);

    assert.deepEqual(render(run), ["○ read a.ts · not finished"]);
});

test("a call the run still works on shows the running icon even before the tool starts", (t) => {
    const run = runOf(t, [assistant([call("t1", "read", { path: "a.ts" })])]);

    run.state = "running";

    assert.deepEqual(render(run), ["◐ read a.ts"]);
});

test("a running tool shows the time since it started", (t) => {
    const run = runOf(t, [assistant([call("t1", "bash", { command: "sleep 9" })])]);

    run.state = "running";
    run.runningTools.set("t1", {
        toolCallId: "t1",
        name: "bash",
        args: {},
        startedAt: Date.now() - 5000,
    });

    const rows = render(run);

    assert.equal(rows.length, 1);
    assert.match(rows[0]!, /^◐ bash sleep 9 · [5-9]\.\ds$/);
});

test("a failed call shows the first three rows of its error and how many lines are left out", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "bash", { command: "make" })]),
        result("t1", lines(5, "error"), { isError: true, durationMs: 1000 }),
    ]);

    assert.deepEqual(render(run), [
        "✕ bash make · 1.0s",
        "    error 1",
        "    error 2",
        "    error 3",
        "    … 2 more lines",
    ]);
});

test("a failed call whose error has one line too many says 1 more line", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "bash", { command: "make" })]),
        result("t1", lines(4, "error"), { isError: true }),
    ]);

    const rows = render(run);

    assert.equal(rows.at(-1), "    … 1 more line");
    assert.equal(rows.length, 5);
});

test("a failed call with a short error shows all of it and no note", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "bash", { command: "make" })]),
        result("t1", "boom\nbang", { isError: true }),
    ]);

    assert.deepEqual(render(run), ["✕ bash make", "    boom", "    bang"]);
});

test("an arguments error is shown like a failed call's error", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "read", { path: "a.ts" }, { argumentsError: lines(4, "bad") })]),
    ]);

    assert.deepEqual(render(run), [
        "○ read a.ts · not finished",
        "    bad 1",
        "    bad 2",
        "    bad 3",
        "    … 1 more line",
    ]);
});

test("a running call shows the last three rows of its partial output after an earlier-lines note", (t) => {
    const run = runOf(t, [assistant([call("t1", "bash", { command: "make" })])]);

    run.state = "running";
    run.runningTools.set("t1", {
        toolCallId: "t1",
        name: "bash",
        args: {},
        startedAt: Date.now(),
        partialResult: { content: [{ type: "text", text: lines(5, "out") }] },
    });

    const rows = render(run);

    assert.deepEqual(rows.slice(1), [
        "    … 2 earlier lines",
        "    out 3",
        "    out 4",
        "    out 5",
    ]);
});

test("a running call with a short partial output shows all of it", (t) => {
    const run = runOf(t, [assistant([call("t1", "bash", { command: "make" })])]);

    run.state = "running";
    run.runningTools.set("t1", {
        toolCallId: "t1",
        name: "bash",
        args: {},
        startedAt: Date.now(),
        partialResult: { content: [{ type: "text", text: "out 1\nout 2" }] },
    });

    assert.deepEqual(render(run).slice(1), ["    out 1", "    out 2"]);
});

test("a long error line is wrapped and counted in rows", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "bash", { command: "make" })]),
        result("t1", "x".repeat(100), { isError: true }),
    ]);

    // Width 40 leaves 36 columns inside the indent: three rows of 36, 36 and 28.
    const rows = render(run, 40);

    assert.deepEqual(rows.slice(1), [
        `    ${"x".repeat(36)}`,
        `    ${"x".repeat(36)}`,
        `    ${"x".repeat(28)}`,
    ]);
});

test("a report call with a result shows its status, reason, question and summary in full", (t) => {
    const run = runOf(t, [
        assistant([
            call("t1", "report", {
                status: "needs_input",
                reason: "Blocked on a choice.",
                question: "Which branch?",
                summary: lines(6, "summary"),
            }),
        ]),
        result("t1", "Report recorded."),
    ]);

    const rows = render(run);

    assert.equal(rows[0], "Report needs_input");
    assert.ok(rows.includes("    Reason: Blocked on a choice."));
    assert.ok(rows.includes("    Question: Which branch?"));
    assert.equal(rows.filter((row) => row.startsWith("    summary ")).length, 6);
});

test("a report call whose run still works on it is marked as being written, status muted", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "report", { status: "done", summary: "Almost there." })]),
    ]);

    run.state = "running";

    const themed = new TranscriptRenderer(fakeTheme({ tag: true })).render(run, 80);

    assert.equal(themed[0], "<toolTitle:Report> <muted:done><dim: · ><warning:writing>");
    assert.ok(themed.includes("    <muted:Almost there.>"));
    assert.equal(render(run)[0], "Report done · writing");
});

test("a report call whose tool is running is marked as being written", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "report", { status: "done", summary: "Almost there." })]),
    ]);

    run.state = "running";
    run.runningTools.set("t1", {
        toolCallId: "t1",
        name: "report",
        args: {},
        startedAt: Date.now(),
    });

    assert.equal(render(run)[0], "Report done · writing");
});

test("a cancelled report call is marked as not sent, status and summary muted", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "report", { status: "blocked", summary: "Never sent." })]),
    ]);

    const themed = new TranscriptRenderer(fakeTheme({ tag: true })).render(run, 80);

    assert.equal(themed[0], "<toolTitle:Report> <muted:blocked><dim: · ><muted:not sent>");
    assert.ok(themed.includes("    <muted:Never sent.>"));
    assert.equal(render(run)[0], "Report blocked · not sent");
});

test("a report call with a result has no mark and keeps its colours", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "report", { status: "done", summary: "All done." })]),
        result("t1", "Report recorded."),
    ]);

    const themed = new TranscriptRenderer(fakeTheme({ tag: true })).render(run, 80);

    assert.equal(themed[0], "<toolTitle:Report> <success:done>");
    assert.ok(themed.some((row) => row.includes("<text:All done.>")));
    assert.ok(!themed.join("\n").includes("writing"));
    assert.ok(!themed.join("\n").includes("not sent"));
});

test("a tool summary is one line even when the command spans several", (t) => {
    const run = runOf(t, [
        assistant([call("t1", "bash", { command: "echo a\n\techo b\x07" })]),
        result("t1", "ok"),
    ]);

    assert.deepEqual(render(run), ["● bash echo a echo b"]);
});

// Thinking

test("a thought is one row with its line count, singular for one line", (t) => {
    const run = runOf(t, [
        assistant([{ type: "thinking", thinking: lines(4) }]),
        assistant([{ type: "thinking", thinking: "just one" }]),
    ]);

    assert.deepEqual(render(run), ["Thinking · 4 lines", "", "Thinking · 1 line"]);
});

test("a redacted thought shows that it is redacted", (t) => {
    const run = runOf(t, [assistant([{ type: "thinking", thinking: "", redacted: true }])]);

    assert.deepEqual(render(run), ["Thinking redacted"]);
});

test("the streamed thought shows its last three wrapped rows indented below the label", (t) => {
    const run = runOf(t, [userMessage("Go.")]);

    run.state = "running";
    run.streaming = assistant([{ type: "thinking", thinking: lines(6, "idea") }]);

    const rows = render(run);

    assert.deepEqual(rows.slice(-4), [
        "Thinking · 6 lines",
        "    idea 4",
        "    idea 5",
        "    idea 6",
    ]);
});

test("the last rows of a streamed thought are wrapped rows, not lines", (t) => {
    const run = runOf(t, []);

    run.state = "running";
    run.streaming = assistant([{ type: "thinking", thinking: "word ".repeat(30).trim() }]);

    const rows = render(run, 24);

    assert.equal(rows[0], "Thinking · 1 line");
    assert.equal(rows.length, 4);

    for (const row of rows.slice(1)) {
        assert.ok(row.startsWith("    ") && row.length <= 24, JSON.stringify(row));
    }
});

test("a thought that is not the last part of the streamed message stays one row", (t) => {
    const run = runOf(t, []);

    run.state = "running";
    run.streaming = assistant([
        { type: "thinking", thinking: lines(6, "idea") },
        { type: "text", text: "Answer." },
    ]);

    assert.deepEqual(render(run), ["Thinking · 6 lines", "Answer."]);
});

test("a thought of a settled message stays one row", (t) => {
    const run = runOf(t, [assistant([{ type: "thinking", thinking: lines(6, "idea") }])]);

    assert.deepEqual(render(run), ["Thinking · 6 lines"]);
});

// Activity

test("a multi-line retry notice becomes several rows and no row holds a newline", (t) => {
    const run = runOf(t, [userMessage("Go.")]);

    run.activity = "Retrying 1/3: 429 rate limited\nretry-after: 12\r\n\tbody: {}";

    const rows = render(run);
    const notice = rows.slice(rows.indexOf("") + 1);

    assert.deepEqual(notice, ["Retrying 1/3: 429 rate limited", "retry-after: 12", "   body: {}"]);

    for (const row of rows) {
        assert.doesNotMatch(row, /[\n\r]/);
    }
});

test("an activity notice is wrapped to the width", (t) => {
    const run = runOf(t, []);

    run.activity = "Compacting ".repeat(10).trim();

    const rows = render(run, 30);

    assert.ok(rows.length > 1);

    for (const row of rows) {
        assert.ok(row.length <= 30, row);
    }
});

// Caching

function countingTheme() {
    const theme = fakeTheme();
    const counter = { calls: 0 };

    for (const key of ["fg", "bold", "italic"] as const) {
        const original = theme[key] as (...args: string[]) => string;

        (theme as unknown as Record<string, unknown>)[key] = (...args: string[]) => {
            counter.calls += 1;

            return original(...args);
        };
    }

    return { theme, counter };
}

/** A run whose transcript the test controls, without a file. */
function scripted(t: TestContext, messages: AgentMessage[]) {
    const run = runOf(t, []);
    const state = { messages };

    run.transcript = () => state.messages;

    return { run, state };
}

function conversation(): AgentMessage[] {
    return [
        userMessage("Review."),
        assistant([{ type: "text", text: "Looking." }, call("t1", "read", { path: "a.ts" })]),
        result("t1", "x", { durationMs: 100 }),
        assistant([{ type: "text", text: "Done." }]),
    ];
}

test("settled messages are drawn once: the next frame of an unchanged transcript builds nothing", (t) => {
    const { run } = scripted(t, conversation());
    const { theme, counter } = countingTheme();
    const renderer = new TranscriptRenderer(theme);

    const first = [...renderer.render(run, 60)];
    const calls = counter.calls;
    const second = [...renderer.render(run, 60)];

    assert.ok(calls > 0);
    assert.equal(counter.calls, calls);
    assert.deepEqual(second, first);
});

test("rows stay correct when a message is appended", (t) => {
    const { run, state } = scripted(t, conversation());
    const renderer = new TranscriptRenderer(fakeTheme());

    renderer.render(run, 60);
    state.messages = [...state.messages, userMessage("One more thing.")];

    const actual = [...renderer.render(run, 60)];
    const expected = [...new TranscriptRenderer(fakeTheme()).render(run, 60)];

    assert.deepEqual(actual, expected);
    assert.equal(actual.at(-1), "One more thing.");
});

test("a call that waits for its result is redrawn when the result arrives", (t) => {
    const messages = conversation().slice(0, 2);
    const { run, state } = scripted(t, messages);
    const renderer = new TranscriptRenderer(fakeTheme());

    run.state = "running";

    assert.ok(renderer.render(run, 60).includes("◐ read a.ts"));

    state.messages = [...messages, result("t1", "x", { durationMs: 2000 })];

    assert.ok(renderer.render(run, 60).includes("● read a.ts · 2.0s"));
});

test("a width change redraws every row at the new width", (t) => {
    const { run } = scripted(t, [assistant([{ type: "text", text: "word ".repeat(40).trim() }])]);
    const renderer = new TranscriptRenderer(fakeTheme());

    const wide = renderer.render(run, 100).length;
    const narrow = [...renderer.render(run, 20)];

    assert.ok(narrow.length > wide);
    assert.deepEqual(narrow, [...new TranscriptRenderer(fakeTheme()).render(run, 20)]);
    assert.deepEqual(
        [...renderer.render(run, 100)],
        [...new TranscriptRenderer(fakeTheme()).render(run, 100)],
    );
});

test("a transcript replaced by new message objects shows the new content", (t) => {
    const { run, state } = scripted(t, conversation());
    const renderer = new TranscriptRenderer(fakeTheme());

    renderer.render(run, 60);
    state.messages = [userMessage("A different task."), assistant([{ type: "text", text: "Ok." }])];

    const actual = [...renderer.render(run, 60)];

    assert.deepEqual(actual, [...new TranscriptRenderer(fakeTheme()).render(run, 60)]);
    assert.ok(actual.includes("A different task."));
    assert.ok(!actual.some((row) => row.includes("Looking.")));
});

test("a transcript that shrinks is drawn from scratch", (t) => {
    const { run, state } = scripted(t, conversation());
    const renderer = new TranscriptRenderer(fakeTheme());

    renderer.render(run, 60);
    state.messages = state.messages.slice(0, 1);

    assert.deepEqual([...renderer.render(run, 60)], ["› Main agent", "Review."]);
});

test("switching between two runs draws each run's own rows", (t) => {
    const first = scripted(t, [userMessage("First run task.")]);
    const second = scripted(t, [userMessage("Second run task.")]);
    const renderer = new TranscriptRenderer(fakeTheme());

    assert.ok(renderer.render(first.run, 60).includes("First run task."));
    assert.ok(renderer.render(second.run, 60).includes("Second run task."));
    assert.ok(renderer.render(first.run, 60).includes("First run task."));
});

test("the streamed message and the activity notice follow the live run on every frame", (t) => {
    const { run } = scripted(t, [userMessage("Go.")]);
    const renderer = new TranscriptRenderer(fakeTheme());

    run.state = "running";
    run.streaming = assistant([{ type: "text", text: "Partial" }]);
    assert.equal(renderer.render(run, 60).at(-1), "Partial");

    run.streaming = assistant([{ type: "text", text: "Partial answer" }]);
    run.activity = "Compacting the context";

    const rows = renderer.render(run, 60);

    assert.deepEqual(rows.slice(-3), ["Partial answer", "", "Compacting the context"]);
    assert.ok(rows.includes("Partial answer"));
    assert.equal(rows.at(-1), "Compacting the context");

    run.activity = undefined;

    assert.ok(!renderer.render(run, 60).includes("Compacting the context"));
});
