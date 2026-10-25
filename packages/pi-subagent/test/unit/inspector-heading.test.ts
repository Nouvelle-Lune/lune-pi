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
