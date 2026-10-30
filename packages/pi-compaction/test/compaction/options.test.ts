import test from "node:test";
import assert from "node:assert/strict";
import {
    validateOptions,
    DEFAULT_COMPACTION_POLICY,
    DEFAULT_CLASSIFIER_CONCURRENCY,
    MAX_CLASSIFIER_CONCURRENCY,
} from "../../src/options.ts";
import type { CompactionOptions } from "../../src/options.ts";
import { policy } from "../harness/fixtures.ts";

function options(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
    return {
        summaryModel: { provider: "summary", id: "model" },
        summaryThinkingLevel: "off",
        jev: { enabled: false },
        policy: policy(),
        ...overrides,
    };
}

test("options require a summary identity and a valid deletion threshold", () => {
    assert.doesNotThrow(() => validateOptions(options()));
    for (const summaryModel of [
        { provider: "", id: "model" },
        { provider: "p", id: " " },
    ])
        assert.throws(() => validateOptions(options({ summaryModel })), /summary model/);
    for (const deleteThreshold of [-1, 1.001, Number.NaN, Infinity])
        assert.throws(
            () => validateOptions(options({ policy: policy({ deleteThreshold }) })),
            /deleteThreshold/,
        );
    for (const deleteThreshold of [0, 0.5, 0.7, 1])
        assert.doesNotThrow(() =>
            validateOptions(options({ policy: policy({ deleteThreshold }) })),
        );
});

test("tool policy accepts explicit user selections and rejects invalid identifiers", () => {
    assert.doesNotThrow(() =>
        validateOptions(
            options({
                policy: policy({ deletableTools: ["bash", "write", "edit", "mcp__docs_search"] }),
            }),
        ),
    );
    for (const deletableTools of [["read", "read"], [" "]])
        assert.throws(
            () => validateOptions(options({ policy: policy({ deletableTools }) })),
            /unique, non-empty/,
        );
});

test("classifier settings accept automatic mode or an explicit provider-qualified model", () => {
    assert.doesNotThrow(() =>
        validateOptions(options({ jev: { enabled: true, model: null, concurrency: 2 } })),
    );
    assert.doesNotThrow(() =>
        validateOptions(
            options({
                jev: {
                    enabled: true,
                    model: { provider: "typesafe", id: "jev-latest" },
                    concurrency: 2,
                },
            }),
        ),
    );
    assert.throws(
        () =>
            validateOptions(
                options({
                    jev: { enabled: true, model: { provider: "", id: "jev" }, concurrency: 2 },
                }),
            ),
        /Classifier reference/,
    );
});

test("default policy exposes only user intent and remains frozen", () => {
    assert.deepEqual(DEFAULT_COMPACTION_POLICY, {
        deleteThreshold: 0.7,
        deletableTools: [
            "read",
            "grep",
            "find",
            "ls",
            "codemode",
            "bash",
            "edit",
            "powershell",
            "tool_search",
        ],
    });
    assert.ok(Object.isFrozen(DEFAULT_COMPACTION_POLICY));
    assert.ok(Object.isFrozen(DEFAULT_COMPACTION_POLICY.deletableTools));
});

test("classifier concurrency accepts integers from 1 to 16 when Jev is enabled", () => {
    for (const concurrency of [1, 2, 16])
        assert.doesNotThrow(() =>
            validateOptions(options({ jev: { enabled: true, model: null, concurrency } })),
        );
    for (const concurrency of [0, -1, 17, 1.5, Number.NaN, Infinity])
        assert.throws(
            () => validateOptions(options({ jev: { enabled: true, model: null, concurrency } })),
            /Classifier concurrency must be an integer from 1 to 16/,
        );
});

test("classifier concurrency is not checked when Jev is disabled", () => {
    assert.doesNotThrow(() => validateOptions(options({ jev: { enabled: false } })));
});

test("the default classifier concurrency is valid and within the cap", () => {
    assert.equal(DEFAULT_CLASSIFIER_CONCURRENCY, 2);
    assert.equal(MAX_CLASSIFIER_CONCURRENCY, 16);
    assert.doesNotThrow(() =>
        validateOptions(
            options({
                jev: { enabled: true, model: null, concurrency: DEFAULT_CLASSIFIER_CONCURRENCY },
            }),
        ),
    );
});
