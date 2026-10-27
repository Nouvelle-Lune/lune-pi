import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { QuestionManager } from "../../src/core/questionManager.ts";
import { QuestionDock } from "../../src/tui/question-dock.ts";
import { createFakeContext, createFakeUi, withoutMargin, type FakeUi } from "../harness.ts";

/** Widget key the extension registers; changing it changes where the dock appears. */
const WIDGET_KEY = "pi-ask-question";

/** Width wide enough that no part of any row below is left out. */
const WIDE = 200;

/** Columns the standalone row reserves around its content: one margin column per side. */
const MARGIN_COLUMNS = 2;

describe("question dock", () => {
    let questionManager: QuestionManager;
    let dock: QuestionDock;
    let ui: FakeUi;

    beforeEach(() => {
        questionManager = new QuestionManager();
        dock = new QuestionDock(questionManager);
        ui = createFakeUi();
    });

    function render(ctx = createFakeContext({ ui })): void {
        dock.setCtx(ctx);
        dock.render();
    }

    /** The row mounted below the editor, rendered at `width` exactly as pi would draw it. */
    function rowAt(width: number): string {
        const content = ui.renderedWidget("belowEditor", WIDGET_KEY, width);
        assert.ok(content, "the dock must be mounted");
        assert.equal(content.length, 1, "the dock must stay a single line");

        return content[0]!;
    }

    /** The dock line at a width that leaves nothing out, without its margin. */
    function line(): string {
        return withoutMargin(rowAt(WIDE));
    }

    /** The row at `width` without its margin, with colour sequences removed. */
    function plainRowAt(width: number): string {
        return stripTerminalSequences(withoutMargin(rowAt(width)));
    }

    /** Render each row at its own width and one column narrower: the next row must appear. */
    function assertRowsShrinkInOrder(rows: readonly string[]): void {
        rows.forEach((expected, index) => {
            const width = visibleWidth(expected) + MARGIN_COLUMNS;
            assert.equal(plainRowAt(width), expected, `at ${width} columns the row must keep it`);

            const narrower = rows[index + 1];
            if (narrower !== undefined) {
                assert.equal(
                    plainRowAt(width - 1),
                    narrower,
                    `one column below ${width} the row must leave out one whole part`,
                );
            }
        });
    }

    it("does nothing before a context is set", () => {
        questionManager.create([{ question: "Which database?" }]);

        dock.render();

        assert.deepEqual(ui.widgetCalls, []);
    });

    it("does nothing without an interactive UI", () => {
        questionManager.create([{ question: "Which database?" }]);

        render(createFakeContext({ ui, hasUI: false }));
        dock.clear();

        assert.deepEqual(ui.widgetCalls, []);
    });

    it("removes the widget when nothing is pending", () => {
        render();

        assert.deepEqual(ui.widgetCalls, [
            { key: WIDGET_KEY, content: undefined, placement: undefined },
        ]);
        assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
    });

    it("mounts the pending question below the editor with the reopen hint", () => {
        questionManager.create([{ question: "Which database?" }]);

        render();

        assert.equal(line(), "1 pending question · Which database? · /question to answer");
        const call = ui.widgetCalls.at(-1);
        assert.equal(call?.key, WIDGET_KEY);
        assert.equal(call?.placement, "belowEditor");
        assert.equal(typeof call?.content, "function", "the row is fitted to the render width");
    });

    it("counts the questions inside each pending request", () => {
        questionManager.create([
            { question: "Which database?" },
            { question: "Which port?" },
            { question: "Which region?" },
        ]);
        questionManager.create([{ question: "Anything else?" }]);

        render();

        const expected = "4 pending questions";
        const actual = line().split(" · ")[0];

        assert.equal(actual, expected);
    });

    it("counts several pending requests and previews the next one", () => {
        questionManager.create([{ question: "First question" }]);
        questionManager.create([{ question: "Second question" }]);

        render();

        assert.equal(line(), "2 pending questions · First question · /question to answer");
    });

    it("previews the request the panel would show next", () => {
        const first = questionManager.create([{ question: "First question" }]);
        questionManager.create([{ question: "Second question" }]);

        // The first one was already on screen, so the newer one is what comes next.
        questionManager.markShown(first.id);

        render();

        assert.equal(line(), "2 pending questions · Second question · /question to answer");
    });

    it("marks that the agent waits while a blocking call waits on the next request", () => {
        const request = questionManager.create([{ question: "Which database?" }]);
        const controller = new AbortController();
        void questionManager.waitForSettle(request.id, controller.signal);

        render();

        assert.equal(
            line(),
            "1 pending question · agent waiting · Which database? · /question to answer",
        );

        controller.abort();
        dock.render();

        assert.equal(line(), "1 pending question · Which database? · /question to answer");
    });

    it("shows a long question whole instead of cutting it", () => {
        const question = `Which ${"x".repeat(100)} database?`;
        questionManager.create([{ question }]);

        render();

        const expected = `1 pending question · ${question} · /question to answer`;
        const actual = plainRowAt(WIDE);

        assert.equal(actual, expected);
        assert.equal(actual.includes("…"), false);
    });

    it("keeps a multi-line question on one line", () => {
        questionManager.create([{ question: "Which database?\nsecond line" }]);

        render();

        assert.equal(rowAt(WIDE).includes("\n"), false);
    });

    it("falls back from the whole question to its header when the complete row does not fit", () => {
        const question = `Which database should the new service use for ${"x".repeat(17)}?`;
        assert.equal(question.length, 64, "guard: the example question is 64 characters");
        const request = questionManager.create([{ question, header: "Database" }]);
        void questionManager.waitForSettle(request.id, new AbortController().signal);

        render();

        assert.equal(
            plainRowAt(80),
            "1 pending question · agent waiting · Database · /question to answer",
        );
        assert.equal(
            plainRowAt(140),
            `1 pending question · agent waiting · ${question} · /question to answer`,
        );
    });

    it("leaves out summary, hint and waiting mark in rank order, keeping the count", () => {
        const request = questionManager.create([
            { question: "Which database?", header: "Database" },
        ]);
        void questionManager.waitForSettle(request.id, new AbortController().signal);

        render();

        assertRowsShrinkInOrder([
            "1 pending question · agent waiting · Which database? · /question to answer",
            "1 pending question · agent waiting · Database · /question to answer",
            "1 pending question · agent waiting · /question to answer",
            "1 pending question · agent waiting",
            "1 pending question",
        ]);
    });

    it("keeps only the margin when even the count does not fit", () => {
        questionManager.create([{ question: "Which database?" }]);

        render();

        const countWidth = visibleWidth("1 pending question");
        for (let width = 0; width < countWidth + MARGIN_COLUMNS; width++) {
            assert.equal(rowAt(width), " ", `at ${width} columns only the margin may remain`);
        }
    });

    it("never renders more than one line wider than the width or cut with an ellipsis", () => {
        const request = questionManager.create([
            { question: "运行测试脚本并输出结果并继续运行并检查日志输出与状态", header: "日志" },
        ]);
        void questionManager.waitForSettle(request.id, new AbortController().signal);

        render();

        for (let width = 0; width <= 120; width++) {
            const row = rowAt(width);
            assert.equal(row.includes("\n"), false, `@${width}: one line only`);
            assert.ok(
                visibleWidth(row) <= Math.max(width, 1),
                `@${width}: row too wide: ${JSON.stringify(row)}`,
            );
            assert.equal(
                stripTerminalSequences(row).includes("…"),
                false,
                `@${width}: no part may be cut with an ellipsis`,
            );
        }
    });

    it("clears only the dock widget", () => {
        questionManager.create([{ question: "Which database?" }]);
        render();

        dock.clear();

        assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
        assert.deepEqual(ui.widgetCalls.at(-1), {
            key: WIDGET_KEY,
            content: undefined,
            placement: undefined,
        });
    });
});
