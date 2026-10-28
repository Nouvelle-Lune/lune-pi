import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { SubagentInspector } from "../../src/inspector/inspector.ts";
import { BODY_TOP, paneGeometry } from "../../src/inspector/layout.ts";
import { runSessionFile } from "../../src/paths.ts";
import {
    assistantMessage,
    fakeCtx,
    fakeTheme,
    parentSession,
    tempAgentDir,
    turn,
    userMessage,
    type RunFileSpec,
} from "./support.ts";

const ROWS = 24;
const done = { status: "done", summary: "ok" } as const;

/** One run in a real manager, opened in an inspector over a plain theme. */
function panel(
    t: TestContext,
    spec: RunFileSpec,
    options: { damage?: (file: string) => void; otherBranch?: boolean } = {},
) {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    session.spawn("aaaa0001", spec);
    options.damage?.(runSessionFile(session.parentId, "aaaa0001", agentDir));

    const { ctx } = fakeCtx({ sessionManager: session.sessionManager, theme: fakeTheme() });
    const manager = session.manager();

    if (options.otherBranch) {
        // An empty leaf puts every run on another branch.
        session.sessionManager.resetLeaf();
    }

    const inspector = new SubagentInspector(
        { ctx, manager, onSeen: () => undefined },
        () => undefined,
        () => undefined,
        () => ROWS,
    );

    t.after(() => inspector.dispose());

    return {
        inspector,
        /** The right pane's body rows, without borders and padding. */
        right(width: number): string[] {
            const geometry = paneGeometry(width, ROWS);
            const lines = inspector.render(width);

            return lines
                .slice(BODY_TOP, BODY_TOP + geometry.bodyHeight)
                .map((line) => line.split("│")[2]!.trim());
        },
        rightWidth: (width: number) => paneGeometry(width, ROWS).rightWidth,
    };
}

function named(name: string, model = "anthropic/claude-opus-5-5"): RunFileSpec {
    return {
        snapshot: { name, model, thinking: "high" },
        messages: [userMessage("Review the diff."), assistantMessage("Looking now.")],
        turns: [turn({ report: done })],
    };
}

test("a wide pane shows the full title and the labelled model row below it", (t) => {
    const { right } = panel(t, named("security-reviewer"));
    const rows = right(140);

    assert.equal(rows[0], "security-reviewer · aaaa0001 · idle · done");
    assert.equal(rows[1], "Model anthropic/claude-opus-5-5 · high");
});

test("the details view adds a label to the title", (t) => {
    const { inspector, right } = panel(t, named("security-reviewer"));

    inspector.handleInput("d");

    assert.equal(right(140)[0], "security-reviewer · aaaa0001 · idle · done · details");
});

test("a narrow pane drops the Model label first", (t) => {
    const { right } = panel(t, named("security-reviewer"));
    const rows = right(60);

    assert.equal(rows[1], "anthropic/claude-opus-5-5 · high");
});

test("the title drops the id, then the report, then the state, and always keeps the name", (t) => {
    const cases: Array<[name: string, expected: string]> = [
        ["a".repeat(30), `${"a".repeat(30)} · idle · done`],
        ["b".repeat(36), `${"b".repeat(36)} · idle`],
        ["c".repeat(42), "c".repeat(42)],
    ];

    for (const [name, expected] of cases) {
        const { right } = panel(t, named(name));

        assert.equal(right(72)[0], expected);
    }
});

test("a long model gets its own wrapped rows, then a level row, and nothing is cut", (t) => {
    const model = "provider-with-a-long-name/model-with-an-extremely-long-identifier-v2-20260101";
    const { right, rightWidth } = panel(t, named("security-reviewer", model));
    const rows = right(72);
    const contentWidth = rightWidth(72) - 2;
    const wrapped = wrapTextWithAnsi(model, contentWidth);

    assert.ok(wrapped.length >= 2);
    assert.deepEqual(rows.slice(1, 1 + wrapped.length), wrapped);
    assert.equal(rows[1 + wrapped.length], "high");
    assert.equal(rows.slice(1, 1 + wrapped.length).join(""), model);

    for (const row of rows) {
        assert.ok(visibleWidth(row) <= contentWidth, row);
    }
});

test("a run whose file cannot be read has a title and no model row", (t) => {
    const { right } = panel(t, named("security-reviewer"), {
        damage: (file) => writeFileSync(file, "{not json at all\n"),
    });
    const rows = right(140);

    assert.equal(rows[0], "aaaa0001 · failed");
    assert.doesNotMatch(rows.slice(1).join("\n"), /Model/);
});

test("the transcript keeps its rows below a model heading that wraps", (t) => {
    const model = "provider-with-a-long-name/model-with-an-extremely-long-identifier-v2-20260101";
    const wide = panel(t, named("security-reviewer"));
    const narrow = panel(t, named("security-reviewer", model));
    const first = (rows: string[]) => rows.findIndex((row) => row.includes("Review the diff."));

    // Narrow: title, two model rows, level row; wide: title and one model row.
    assert.equal(first(narrow.right(72)) - first(wide.right(140)), 2);
});

test("presses on the transcript are not claimed, whatever row they hit", (t) => {
    const model = "provider-with-a-long-name/model-with-an-extremely-long-identifier-v2-20260101";
    const { inspector, right } = panel(t, {
        snapshot: { name: "security-reviewer", model, thinking: "high" },
        messages: [userMessage("Review the diff."), assistantMessage("Looking now.")],
        turns: [turn({ report: done })],
    });
    const geometry = paneGeometry(72, ROWS);
    const rows = right(72);
    const press = (row: number): ReturnType<SubagentInspector["handleMouse"]> =>
        inspector.handleMouse({
            type: "press",
            button: "left",
            x: geometry.rightStart + 3,
            y: BODY_TOP + row,
        } as TuiMouseEvent);
    const firstTranscriptRow = rows.findIndex((row) => row.includes("Review the diff."));

    // Title, two wrapped model rows, the level row and the message header come first.
    assert.equal(firstTranscriptRow, 5);

    for (let row = 0; row < rows.length; row++) {
        assert.equal(press(row), undefined, `row ${row}`);
    }
});

test("a run of another branch is labelled after its report", (t) => {
    const { right } = panel(t, named("security-reviewer"), { otherBranch: true });

    assert.equal(right(140)[0], "security-reviewer · aaaa0001 · idle · done · other branch");
});

/** A transcript longer than the body, scrolled up by one row so one newer row is hidden. */
function scrolledUp(t: TestContext, name: string) {
    const messages: AgentMessage[] = Array.from({ length: 40 }, (_, index) =>
        assistantMessage(`Step ${index}.`),
    );
    const fx = panel(t, { ...named(name), messages });

    fx.right(140);
    fx.inspector.handleInput("K");

    return fx;
}

test("scrolling up shows how many newer rows are hidden, after every other label", (t) => {
    const { right } = scrolledUp(t, "security-reviewer");

    assert.equal(right(140)[0], "security-reviewer · aaaa0001 · idle · done · ↓ 1 newer · End");
});

test("a narrow title keeps the newer-rows label after the id and the report are gone", (t) => {
    const name = "d".repeat(20);
    const { right } = scrolledUp(t, name);

    assert.equal(right(72)[0], `${name} · idle · ↓ 1 newer · End`);
});

// The auto mark on the model row

function autoRun(
    autoModel: unknown,
    model = "anthropic/claude-opus-5-5",
    thinking = "high",
): RunFileSpec {
    return {
        snapshot: { name: "security-reviewer", model, thinking, autoModel } as never,
        messages: [userMessage("Review the diff."), assistantMessage("Looking now.")],
        turns: [turn({ report: done })],
    };
}

const tierRating = (overrides: Record<string, unknown> = {}) => ({
    by: "rating",
    classifier: "c/j",
    tier: {
        rated: "complex",
        used: "complex",
        confidence: 0.8,
        probabilities: { light: 0.04, standard: 0.12, complex: 0.71, deep: 0.13 },
        ...overrides,
    },
    modelFrom: "complex",
    thinking: { rated: "high", used: "high", confidence: 0.9, probabilities: {} },
});

test("the model row of an auto run ends with the tier used and its share", (t) => {
    const { right } = panel(t, autoRun(tierRating()));

    assert.equal(right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto complex 71%");
});

test("an unsure rating moved up shows the tier used without a share", (t) => {
    const { right } = panel(
        t,
        autoRun(tierRating({ rated: "standard", used: "complex", confidence: 0.4 })),
    );

    assert.equal(right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto complex");
});

test("a rating without shares shows the tier used alone", (t) => {
    const { right } = panel(t, autoRun(tierRating({ probabilities: {} })));

    assert.equal(right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto complex");
});

test("an auto run without a rating shows a plain auto mark", (t) => {
    for (const autoModel of [{ by: "no-classifier" }, { by: "nothing-to-rate" }]) {
        const { right } = panel(t, autoRun(autoModel));

        assert.equal(right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto");
    }
});

test("a run without an auto choice has no auto mark", (t) => {
    const { right } = panel(t, autoRun(undefined));

    assert.equal(right(140)[1], "Model anthropic/claude-opus-5-5 · high");
});

test("the auto mark stays with the thinking: after the model, then on its own row, also under a long model", (t) => {
    const narrow = panel(t, autoRun(tierRating()));
    const model = "provider-with-a-long-name/model-with-an-extremely-long-identifier-v2-20260101";
    const long = panel(t, autoRun(tierRating(), model));
    const rows = long.right(72);
    const wrapped = wrapTextWithAnsi(model, long.rightWidth(72) - 2);

    assert.equal(narrow.right(80)[1], "anthropic/claude-opus-5-5 · high · auto complex 71%");
    assert.deepEqual(narrow.right(70).slice(1, 3), [
        "anthropic/claude-opus-5-5",
        "high · auto complex 71%",
    ]);
    assert.deepEqual(rows.slice(1, 1 + wrapped.length), wrapped);
    assert.equal(rows[1 + wrapped.length], "high · auto complex 71%");
});

const failedClassifier = {
    by: "classifier-failed",
    classifier: "c/j",
    error: "The auto classifier c/j is unavailable.",
};

test("the model row of a run whose classifier failed ends with auto failed", (t) => {
    const wide = panel(t, autoRun(failedClassifier));
    const narrow = panel(t, autoRun(failedClassifier));

    assert.equal(wide.right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto failed");
    assert.equal(narrow.right(76)[1], "anthropic/claude-opus-5-5 · high · auto failed");
    assert.deepEqual(narrow.right(70).slice(1, 3), [
        "anthropic/claude-opus-5-5",
        "high · auto failed",
    ]);
});

test("the auto failed mark uses the warning color", (t) => {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    session.spawn("aaaa0001", autoRun(failedClassifier));

    const { ctx } = fakeCtx({
        sessionManager: session.sessionManager,
        theme: fakeTheme({ tag: true }),
    });
    const inspector = new SubagentInspector(
        { ctx, manager: session.manager(), onSeen: () => undefined },
        () => undefined,
        () => undefined,
        () => ROWS,
    );

    t.after(() => inspector.dispose());

    assert.match(inspector.render(140).join("\n"), /<warning:auto failed>/);
});

const riskyRating = (risk: Record<string, unknown>) => ({ ...tierRating(), risk });
const HIGH = { probability: 0.72, threshold: 0.4, high: true, floor: "deep" };

test("a task rated high risk adds a high risk part to the model row", (t) => {
    const { right } = panel(t, autoRun(riskyRating(HIGH)));

    assert.equal(
        right(140)[1],
        "Model anthropic/claude-opus-5-5 · high · auto complex 71% · high risk",
    );
});

test("a task that is not high risk, or has no risk rating, has no high risk part", (t) => {
    const calm = panel(t, autoRun(riskyRating({ probability: 0.1, threshold: 0.4, high: false })));
    const older = panel(t, autoRun(tierRating()));

    assert.equal(calm.right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto complex 71%");
    assert.equal(older.right(140)[1], "Model anthropic/claude-opus-5-5 · high · auto complex 71%");
});

test("the high risk part uses the warning color", (t) => {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    session.spawn("aaaa0001", autoRun(riskyRating(HIGH)));

    const { ctx } = fakeCtx({
        sessionManager: session.sessionManager,
        theme: fakeTheme({ tag: true }),
    });
    const inspector = new SubagentInspector(
        { ctx, manager: session.manager(), onSeen: () => undefined },
        () => undefined,
        () => undefined,
        () => ROWS,
    );

    t.after(() => inspector.dispose());

    assert.match(inspector.render(140).join("\n"), /<warning:high risk>/);
});

test("the settings stay on the model row while they fit, then go below it as whole parts", (t) => {
    const model = "anthropic/claude-opus-5-5";
    const { right } = panel(t, autoRun(riskyRating(HIGH)));

    // The label is dropped first, then the settings move below the model together.
    assert.equal(right(100)[1], `${model} · high · auto complex 71% · high risk`);
    assert.deepEqual(right(90).slice(1, 3), [model, "high · auto complex 71% · high risk"]);
    assert.deepEqual(right(70).slice(1, 3), [model, "high · auto complex 71% · high risk"]);
});

test("in a pane too narrow for all settings on one row the parts that do not fit go on the next row", (t) => {
    const model = "anthropic/claude-opus-5-5";
    const { right, rightWidth } = panel(t, autoRun(riskyRating(HIGH)));

    for (const width of [60, 52]) {
        const rows = right(width).slice(1, 4);

        assert.deepEqual(rows, [model, "high · auto complex 71%", "high risk"], `${width}`);
        assert.ok(rows.every((row) => visibleWidth(row) <= rightWidth(width) - 2));
    }
});
