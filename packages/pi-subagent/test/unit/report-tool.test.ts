import assert from "node:assert/strict";
import { test } from "node:test";

import { createReportTool, normalizeReport, REPORT_TOOL_NAME } from "../../src/run/report-tool.ts";
import type { RunReport } from "../../src/run/types.ts";

test("a done report keeps the trimmed summary and no reason or question", () => {
    const actual = normalizeReport({ status: "done", summary: "  All good.  " });

    assert.deepEqual(actual, { status: "done", summary: "All good." });
});

test("a blocked report needs a reason", () => {
    assert.throws(() => normalizeReport({ status: "blocked", summary: "Partial." }), /reason/);
    assert.throws(
        () => normalizeReport({ status: "blocked", summary: "Partial.", reason: "   " }),
        /reason/,
    );
    assert.deepEqual(
        normalizeReport({ status: "blocked", summary: "Partial.", reason: " No access. " }),
        { status: "blocked", summary: "Partial.", reason: "No access." },
    );
});

test("a needs_input report needs a question", () => {
    assert.throws(() => normalizeReport({ status: "needs_input", summary: "Stuck." }), /question/);
    assert.deepEqual(
        normalizeReport({ status: "needs_input", summary: "Stuck.", question: "Which one?" }),
        { status: "needs_input", summary: "Stuck.", question: "Which one?" },
    );
});

test("the report tool records the report and ends the turn", async () => {
    const recorded: RunReport[] = [];
    const tool = createReportTool((report) => recorded.push(report));

    const result = await tool.execute(
        "call-1",
        { status: "needs_input", summary: " Waiting. ", question: "Which branch?" },
        undefined,
        undefined,
        undefined as never,
    );

    const expected: RunReport = {
        status: "needs_input",
        summary: "Waiting.",
        question: "Which branch?",
    };

    assert.equal(tool.name, REPORT_TOOL_NAME);
    assert.deepEqual(recorded, [expected]);
    assert.deepEqual(result.details, expected);
    assert.equal(result.terminate, true);
});

test("an invalid report throws for the model to retry and records nothing", async () => {
    const recorded: RunReport[] = [];
    const tool = createReportTool((report) => recorded.push(report));

    await assert.rejects(
        tool.execute(
            "call-1",
            { status: "blocked", summary: "No." },
            undefined,
            undefined,
            undefined as never,
        ),
        /reason/,
    );
    assert.deepEqual(recorded, []);
});

test("the report schema offers exactly the three statuses", () => {
    const tool = createReportTool(() => undefined);
    const status = (tool.parameters as { properties: { status: { enum: string[] } } }).properties
        .status;

    assert.deepEqual(status.enum, ["done", "blocked", "needs_input"]);
});
