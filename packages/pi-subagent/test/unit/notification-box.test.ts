import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderRunNotificationBox } from "../../src/notify/notification-box.ts";
import { buildRunNotification, type RunNotice } from "../../src/notify/notifier.ts";
import type { LuneActivity } from "../../src/render/lune-theme.ts";
import { fakeTheme, turn } from "./support.ts";

const RENDERER_KEY = Symbol.for("@lune_99/pi-core-theme/renderer/v1");
const globals = globalThis as Record<symbol, unknown>;
const options = (expanded = false): MessageRenderOptions =>
    ({ expanded, outputPad: 1 }) as MessageRenderOptions;

let saved: PropertyDescriptor | undefined;

beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globals, RENDERER_KEY);
    delete globals[RENDERER_KEY];
});

afterEach(() => {
    delete globals[RENDERER_KEY];

    if (saved) {
        Object.defineProperty(globals, RENDERER_KEY, saved);
    }
});

function message(batch: RunNotice[]) {
    return buildRunNotification(batch);
}

const notice = (runId: string, record = turn({ report: { status: "done", summary: "ok" } })) => ({
    runId,
    name: `agent-${runId}`,
    record,
});

test("a message without runs is left to Pi's own row", () => {
    assert.equal(
        renderRunNotificationBox(
            { content: "text", details: { runs: [] } },
            options(),
            fakeTheme(),
        ),
        undefined,
    );
    assert.equal(renderRunNotificationBox({ content: "text" }, options(), fakeTheme()), undefined);
});

test("without Core Theme the box draws a header, a run row and the report", () => {
    const { content, details } = message([
        notice("r1", turn({ report: { status: "done", summary: "All good." } })),
    ]);

    const rows = renderRunNotificationBox({ content, details }, options(), fakeTheme())!.render(60);
    const text = rows.join("\n");

    assert.match(text, /● Subagent agent-r1 ended its turn/);
    assert.match(text, /agent-r1 \(r1\) · idle · done · 4\.2s/);
    assert.match(text, /All good\./);
    assert.ok(rows.every((row) => visibleWidth(row) === 60));
});

test("the box shows the reason, the question and the error of each run", () => {
    const { content, details } = message([
        notice("r1", turn({ report: { status: "blocked", summary: "s", reason: "No key." } })),
        notice("r2", turn({ report: { status: "needs_input", summary: "s", question: "Which?" } })),
        notice("r3", turn({ state: "failed", error: "boom" })),
    ]);

    const text = renderRunNotificationBox({ content, details }, options(), fakeTheme())!
        .render(80)
        .join("\n");

    assert.match(text, /3 subagent turns ended/);
    assert.match(text, /Reason: No key\./);
    assert.match(text, /Question: Which\?/);
    assert.match(text, /Error: boom/);
    assert.match(text, /failed · unreported/);
});

test("a collapsed box previews five report lines and an expanded one shows them all", () => {
    const summary = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    const { content, details } = message([
        notice("r1", turn({ report: { status: "done", summary } })),
    ]);

    const collapsed = renderRunNotificationBox({ content, details }, options(false), fakeTheme())!
        .render(80)
        .join("\n");
    const expanded = renderRunNotificationBox({ content, details }, options(true), fakeTheme())!
        .render(80)
        .join("\n");

    assert.match(collapsed, /line 5/);
    assert.doesNotMatch(collapsed, /line 6/);
    assert.match(collapsed, /… 4 more lines · ctrl\+o to expand/);
    assert.match(expanded, /line 9/);
});

test("the band is red for a failure, accent for needs_input and green otherwise", () => {
    const theme = fakeTheme({ tag: true });
    const render = (record: ReturnType<typeof turn>) => {
        const { content, details } = message([notice("r1", record)]);

        return renderRunNotificationBox({ content, details }, options(), theme)!
            .render(60)
            .join("\n");
    };

    assert.match(render(turn({ state: "failed" })), /\[toolErrorBg:/);
    assert.match(
        render(turn({ report: { status: "blocked", summary: "s", reason: "r" } })),
        /\[toolErrorBg:/,
    );
    assert.match(
        render(turn({ report: { status: "needs_input", summary: "s", question: "q" } })),
        /\[toolPendingBg:/,
    );
    assert.match(render(turn({ report: { status: "done", summary: "s" } })), /\[toolSuccessBg:/);
});

test("with Core Theme the box delegates to its activity renderer, keeping state and report apart", () => {
    const calls: Array<{ activity: LuneActivity; expanded: boolean }> = [];

    globals[RENDERER_KEY] = {
        version: 1,
        renderActivity: (activity: LuneActivity, opts: { expanded: boolean }) => {
            calls.push({ activity, expanded: opts.expanded });

            return { render: () => ["themed"], invalidate() {} };
        },
    };

    const { content, details } = message([
        notice("r1", turn({ state: "interrupted", stoppedBy: "user" })),
        {
            ...notice("r2", turn({ report: { status: "done", summary: "First line.\nMore." } })),
            copied: true,
        },
    ]);

    const box = renderRunNotificationBox({ content, details }, options(true), fakeTheme())!;

    assert.deepEqual(box.render(50), ["themed"]);
    box.render(50);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.expanded, true);
    assert.equal(calls[0]!.activity.title, "subagents");
    assert.equal(calls[0]!.activity.summary, "2 runs");
    assert.deepEqual(
        calls[0]!.activity.entries.map((entry) => [entry.name, entry.status, entry.detail]),
        [
            ["agent-r1", "cancelled", "unreported"],
            ["agent-r2", "done", "done · copied"],
        ],
    );
    assert.equal(calls[0]!.activity.entries[1]!.summary, "First line.");
});

test("the renderer is looked up on every render, so removing it restores the standalone box", () => {
    globals[RENDERER_KEY] = {
        version: 1,
        renderActivity: () => ({ render: () => ["themed"], invalidate() {} }),
    };

    const { content, details } = message([notice("r1")]);
    const box = renderRunNotificationBox({ content, details }, options(), fakeTheme())!;

    assert.deepEqual(box.render(60), ["themed"]);

    delete globals[RENDERER_KEY];

    assert.match(box.render(60).join("\n"), /Subagent agent-r1 ended its turn/);
});

test("a renderer with another protocol version is ignored", () => {
    globals[RENDERER_KEY] = { version: 2, renderActivity: () => ({ render: () => ["themed"] }) };

    const { content, details } = message([notice("r1")]);
    const rows = renderRunNotificationBox({ content, details }, options(), fakeTheme())!.render(60);

    assert.doesNotMatch(rows.join("\n"), /themed/);
});

// Earlier reports

const earlierNotice = () =>
    notice(
        "r1",
        turn({
            earlierReports: [
                { status: "blocked", summary: "First try.", reason: "No key." },
                { status: "needs_input", summary: "Second try.", question: "Which?" },
            ],
            report: { status: "done", summary: "Final." },
        }),
    );

test("a collapsed box shows one muted row per earlier report and hides its text", () => {
    const { content, details } = message([earlierNotice()]);
    const text = renderRunNotificationBox({ content, details }, options(false), fakeTheme())!
        .render(100)
        .join("\n");

    assert.match(text, /Earlier report: blocked, replaced by a later one · ctrl\+o to expand/);
    assert.match(text, /Earlier report: needs_input, replaced by a later one · ctrl\+o to expand/);
    assert.match(text, /Final\./);
    assert.doesNotMatch(text, /First try\./);
    assert.doesNotMatch(text, /No key\./);
    assert.doesNotMatch(text, /Which\?/);
});

test("an expanded box shows each earlier report with its reason, question and summary", () => {
    const { content, details } = message([earlierNotice()]);
    const text = renderRunNotificationBox({ content, details }, options(true), fakeTheme())!
        .render(100)
        .join("\n");

    assert.match(text, /Earlier report: blocked, replaced by a later one\s*\n/);
    assert.doesNotMatch(text, /to expand/);
    assert.match(text, /Reason: No key\./);
    assert.match(text, /First try\./);
    assert.match(text, /Question: Which\?/);
    assert.match(text, /Second try\./);
});

test("the earlier report rows use the muted, error and accent colours", () => {
    const { content, details } = message([earlierNotice()]);
    const text = renderRunNotificationBox(
        { content, details },
        options(true),
        fakeTheme({ tag: true }),
    )!
        .render(100)
        .join("\n");

    assert.match(text, /<muted:Earlier report: blocked/);
    assert.match(text, /<error:Reason: No key\./);
    assert.match(text, /<accent:Question: Which\?/);
});

test("with Core Theme the entry counts the earlier reports and appends their text to its output", () => {
    const calls: LuneActivity[] = [];

    globals[RENDERER_KEY] = {
        version: 1,
        renderActivity: (activity: LuneActivity) => {
            calls.push(activity);

            return { render: () => ["themed"], invalidate() {} };
        },
    };

    const { content, details } = message([earlierNotice()]);

    renderRunNotificationBox({ content, details }, options(true), fakeTheme())!.render(50);

    const entry = calls[0]!.entries[0]!;

    assert.equal(entry.detail, "done · 2 earlier reports");
    assert.match(entry.output ?? "", /^Final\./);
    assert.match(entry.output ?? "", /Earlier report: blocked, replaced by a later one/);
    assert.match(entry.output ?? "", /Reason: No key\./);
    assert.match(entry.output ?? "", /First try\./);
    assert.match(entry.output ?? "", /Question: Which\?/);
});

test("with Core Theme a single earlier report is counted in the singular", () => {
    const calls: LuneActivity[] = [];

    globals[RENDERER_KEY] = {
        version: 1,
        renderActivity: (activity: LuneActivity) => {
            calls.push(activity);

            return { render: () => ["themed"], invalidate() {} };
        },
    };

    const { content, details } = message([
        notice(
            "r1",
            turn({
                earlierReports: [{ status: "blocked", summary: "x", reason: "y" }],
                report: { status: "done", summary: "Final." },
            }),
        ),
    ]);

    renderRunNotificationBox({ content, details }, options(false), fakeTheme())!.render(50);

    assert.equal(calls[0]!.entries[0]!.detail, "done · 1 earlier report");
});
