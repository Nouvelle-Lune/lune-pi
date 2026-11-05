import test from "node:test";
import assert from "node:assert/strict";
import type {
    ClassifierContext,
    ClassifierQuestion,
    ClassifierResult,
} from "@earendil-works/pi-ai";
import { runRequests, validateAnswers } from "../../src/tool-review/classification.ts";

function question(id: string): ClassifierQuestion {
    return { type: "bool", instructions: id, criteria: { true: "yes", false: "no" } };
}

function contextWith(ids: string[]): ClassifierContext {
    return { state: {}, questions: Object.fromEntries(ids.map((id) => [id, question(id)])) };
}

function result(
    answers: Record<string, { type: "bool"; probability: number }>,
    overrides: Partial<ClassifierResult> = {},
): ClassifierResult {
    return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev",
        answers,
        stopReason: "stop",
        timestamp: 0,
        ...overrides,
    };
}

test("validateAnswers accepts a complete, finite bool answer set", () => {
    assert.doesNotThrow(() =>
        validateAnswers(result({ a: { type: "bool", probability: 0.2 } }), contextWith(["a"])),
    );
});

test("validateAnswers rejects a non-stop classifier result", () => {
    assert.throws(
        () =>
            validateAnswers(
                result({}, { stopReason: "error", errorMessage: "boom" }),
                contextWith([]),
            ),
        /Jev error: boom/,
    );
    assert.throws(
        () => validateAnswers(result({}, { stopReason: "aborted" }), contextWith([])),
        /Jev aborted/,
    );
});

test("validateAnswers rejects unknown and missing answer ids", () => {
    assert.throws(
        () =>
            validateAnswers(
                result({ extra: { type: "bool", probability: 0.1 } }),
                contextWith(["a"]),
            ),
        /unknown answer/,
    );
    assert.throws(() => validateAnswers(result({}), contextWith(["a"])), /invalid probability/);
});

test("validateAnswers rejects non-finite, out-of-range and non-bool answers", () => {
    assert.throws(
        () =>
            validateAnswers(
                result({ a: { type: "bool", probability: Number.NaN } }),
                contextWith(["a"]),
            ),
        /invalid probability/,
    );
    assert.throws(
        () =>
            validateAnswers(result({ a: { type: "bool", probability: 1.5 } }), contextWith(["a"])),
        /invalid probability/,
    );
    assert.throws(
        () =>
            validateAnswers(result({ a: { type: "bool", probability: -0.1 } }), contextWith(["a"])),
        /invalid probability/,
    );
    assert.throws(
        () =>
            validateAnswers(
                result({ a: { type: "score", score: 1, confidence: 1 } as never }),
                contextWith(["a"]),
            ),
        /invalid probability/,
    );
});

test("runRequests keeps a bounded worker pool and preserves result order", async () => {
    const contexts = [
        contextWith(["a"]),
        contextWith(["b"]),
        contextWith(["c"]),
        contextWith(["d"]),
    ];
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const progress: [number, number][] = [];
    const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
        active++;
        started++;
        maxActive = Math.max(maxActive, active);
        if (started === 2) release();
        await gate;
        active--;
        const id = Object.keys(context.questions)[0]!;
        return result({ [id]: { type: "bool", probability: 0.1 } });
    };
    const results = await runRequests(
        contexts,
        classify,
        2,
        new AbortController().signal,
        (completed, total) => progress.push([completed, total]),
    );
    assert.equal(results.length, 4);
    assert.equal(maxActive, 2);
    assert.deepEqual(progress.at(-1), [4, 4]);
    assert.deepEqual(progress[0], [0, 4]);
    assert.deepEqual(
        results.map((entry) => Object.keys(entry.answers)[0]),
        ["a", "b", "c", "d"],
    );
});

test("runRequests cancels sibling requests when one batch member fails", async () => {
    const contexts = [contextWith(["a"]), contextWith(["boom"]), contextWith(["c"])];
    const signals: AbortSignal[] = [];
    const classify = (
        context: ClassifierContext,
        signal: AbortSignal,
    ): Promise<ClassifierResult> => {
        signals.push(signal);
        const id = Object.keys(context.questions)[0]!;
        if (id === "boom") return Promise.reject(new Error("classification transport failed"));
        return new Promise<ClassifierResult>((resolve) => {
            signal.addEventListener(
                "abort",
                () => resolve(result({ [id]: { type: "bool", probability: 0 } })),
                { once: true },
            );
        });
    };
    await assert.rejects(
        runRequests(contexts, classify, 2, new AbortController().signal, () => undefined),
        /classification transport failed/,
    );
    assert.ok(signals.every((signal) => signal.aborted));
});

test("runRequests surfaces a validation failure as a batch failure", async () => {
    const contexts = [contextWith(["a"])];
    const classify = (): Promise<ClassifierResult> =>
        Promise.resolve(result({ a: { type: "bool", probability: 5 } }));
    await assert.rejects(
        runRequests(contexts, classify, 2, new AbortController().signal, () => undefined),
        /invalid probability/,
    );
});

test("runRequests refuses to start on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let called = false;
    await assert.rejects(
        runRequests(
            [contextWith(["a"])],
            () => {
                called = true;
                return Promise.resolve(result({}));
            },
            2,
            controller.signal,
            () => undefined,
        ),
        /cancelled/,
    );
    assert.equal(called, false);
});

test("a provider context limit is retained as a result while later requests continue", async () => {
    // Length rejection is a preserve decision, not authorization to drop or retry.
    const contexts = [contextWith(["a"]), contextWith(["b"])];
    let calls = 0;
    const results = await runRequests(
        contexts,
        async (context) => {
            calls++;
            return context.questions.a
                ? result({}, { stopReason: "error", errorMessage: "context_length_exceeded" })
                : result({ b: { type: "bool", probability: 1 } });
        },
        2,
        new AbortController().signal,
        () => undefined,
    );
    assert.equal(calls, 2);
    assert.equal(results[0]!.stopReason, "error");
    assert.deepEqual(results[1]!.answers, { b: { type: "bool", probability: 1 } });
});

for (const [concurrency, count] of [
    [3, 6],
    [8, 3],
    [1, 4],
] as const)
    test(`runRequests keeps min(concurrency, requests) requests in flight for concurrency ${concurrency} and ${count} requests`, async () => {
        const ids = Array.from({ length: count }, (_, index) => `q${index}`);
        const expectedActive = Math.min(concurrency, count);
        let active = 0;
        let maxActive = 0;
        let started = 0;
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
            active++;
            started++;
            maxActive = Math.max(maxActive, active);
            // Hold every request until the whole first wave is in flight so the peak is deterministic.
            if (started === expectedActive) release();
            await gate;
            active--;
            const id = Object.keys(context.questions)[0]!;
            return result({ [id]: { type: "bool", probability: 0.1 } });
        };
        const results = await runRequests(
            ids.map((id) => contextWith([id])),
            classify,
            concurrency,
            new AbortController().signal,
            () => undefined,
        );
        const expectedOrder = ids;
        const actualOrder = results.map((entry) => Object.keys(entry.answers)[0]);
        assert.equal(maxActive, expectedActive);
        assert.deepEqual(actualOrder, expectedOrder);
    });

test("runRequests rejects a concurrency that is not a positive integer without classifying", async () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN, Infinity]) {
        let called = false;
        await assert.rejects(
            runRequests(
                [contextWith(["a"])],
                () => {
                    called = true;
                    return Promise.resolve(result({}));
                },
                concurrency,
                new AbortController().signal,
                () => undefined,
            ),
            /Classifier concurrency must be a positive integer/,
        );
        assert.equal(called, false, `concurrency ${concurrency} must not classify`);
    }
});
