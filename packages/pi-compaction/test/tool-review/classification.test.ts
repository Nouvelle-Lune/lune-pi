import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type {
    ClassifierContext,
    ClassifierQuestion,
    ClassifierResult,
} from "@earendil-works/pi-ai";

// The retry backoff uses timers/promises.setTimeout, which node:test can fake only when the clock
// exists before the module binds it. Keep one instance enabled so every test ticks the same clock.
mock.timers.enable({ apis: ["setTimeout"] });
const { runRequests, validateAnswers } = await import("../../src/tool-review/classification.ts");

// A failed test must not leave backoff timers on the clock seen by the next test.
test.afterEach(() => {
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout"] });
});

function question(id: string): ClassifierQuestion {
    return { type: "bool", instructions: id, criteria: { true: "yes", false: "no" } };
}

function contextWith(ids: string[]): ClassifierContext {
    return { state: {}, questions: Object.fromEntries(ids.map((id) => [id, question(id)])) };
}

const TRANSIENT_SOCKET_ERROR = "fetch failed: other side closed (UND_ERR_SOCKET)";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

// Undici surfaces a dropped socket as a fetch failure whose cause carries the socket code.
function fetchFailure(): Error {
    return new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
}

function connectionReset(): Error {
    return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

// Drains the promise chain that arms a backoff without advancing the fake clock.
function settleMicrotasks(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
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

test("runRequests retries a returned transient transport error without cancelling siblings", async () => {
    const contexts = [contextWith(["a"]), contextWith(["b"])];
    const progress: [number, number][] = [];
    const firstAttempt = deferred();
    const releaseSibling = deferred();
    let attempts = 0;
    let siblingAbortedWhenAnswered = true;
    const classify = async (
        context: ClassifierContext,
        signal: AbortSignal,
    ): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        if (id === "b") {
            await releaseSibling.promise;
            siblingAbortedWhenAnswered = signal.aborted;
            return result({ b: { type: "bool", probability: 0.9 } });
        }
        attempts++;
        firstAttempt.resolve();
        // Classifiers normalize transport failures into stopped results instead of throwing.
        if (attempts === 1)
            return result({}, { stopReason: "error", errorMessage: TRANSIENT_SOCKET_ERROR });
        return result({ a: { type: "bool", probability: 0.2 } });
    };
    const run = runRequests(
        contexts,
        classify,
        2,
        new AbortController().signal,
        (completed, total) => progress.push([completed, total]),
    );
    // Observe the pending run so an intermediate assertion cannot surface as an unhandled rejection.
    run.catch(() => undefined);
    await firstAttempt.promise;
    await settleMicrotasks();
    // The sibling answers while the retrying request waits, so its signal is sampled mid-backoff.
    releaseSibling.resolve();
    await settleMicrotasks();
    assert.deepEqual(progress, [
        [0, 2],
        [1, 2],
    ]);
    mock.timers.tick(500);
    const results = await run;
    const actualAnswers = results.map((entry) => entry.answers);
    assert.equal(attempts, 2);
    assert.deepEqual(actualAnswers, [
        { a: { type: "bool", probability: 0.2 } },
        { b: { type: "bool", probability: 0.9 } },
    ]);
    assert.equal(siblingAbortedWhenAnswered, false, "a retry must not cancel sibling requests");
    // Only the final completion of each fragment counts toward progress.
    assert.deepEqual(progress, [
        [0, 2],
        [1, 2],
        [2, 2],
    ]);
});

test("runRequests retries thrown fetch and socket failures until a request succeeds", async () => {
    const contexts = [contextWith(["fetch"]), contextWith(["socket"])];
    const attempts = new Map<string, number>();
    const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (attempt === 1) throw id === "fetch" ? fetchFailure() : connectionReset();
        return result({ [id]: { type: "bool", probability: 0.4 } });
    };
    const run = runRequests(contexts, classify, 2, new AbortController().signal, () => undefined);
    run.catch(() => undefined);
    await settleMicrotasks();
    assert.equal(attempts.get("fetch"), 1);
    assert.equal(attempts.get("socket"), 1);
    mock.timers.tick(500);
    const results = await run;
    assert.equal(attempts.get("fetch"), 2);
    assert.equal(attempts.get("socket"), 2);
    assert.deepEqual(
        results.map((entry) => Object.keys(entry.answers)[0]),
        ["fetch", "socket"],
    );
    assert.deepEqual(
        results.map((entry) => entry.stopReason),
        ["stop", "stop"],
    );
});

test("runRequests stops after three attempts and aborts siblings only after the final failure", async () => {
    const contexts = [contextWith(["boom"]), contextWith(["sibling"])];
    const attemptStarted = Array.from({ length: 3 }, () => deferred());
    const failures: Error[] = [];
    const progress: [number, number][] = [];
    let siblingAborted = false;
    const classify = (
        context: ClassifierContext,
        signal: AbortSignal,
    ): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        if (id === "sibling")
            return new Promise<ClassifierResult>((resolve) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        siblingAborted = true;
                        resolve(result({ sibling: { type: "bool", probability: 0 } }));
                    },
                    { once: true },
                );
            });
        const failure = connectionReset();
        failures.push(failure);
        attemptStarted[failures.length - 1]!.resolve();
        return Promise.reject(failure);
    };
    const run = runRequests(
        contexts,
        classify,
        2,
        new AbortController().signal,
        (completed, total) => progress.push([completed, total]),
    );
    run.catch(() => undefined);
    await attemptStarted[0]!.promise;
    await settleMicrotasks();
    assert.equal(siblingAborted, false, "a retryable failure must keep siblings alive");
    mock.timers.tick(499);
    await settleMicrotasks();
    assert.equal(failures.length, 1, "the first retry must wait 500 ms");
    mock.timers.tick(1);
    await attemptStarted[1]!.promise;
    await settleMicrotasks();
    assert.equal(failures.length, 2);
    assert.equal(siblingAborted, false, "the second failure is still retryable");
    mock.timers.tick(999);
    await settleMicrotasks();
    assert.equal(failures.length, 2, "the second retry must wait 1000 ms");
    mock.timers.tick(1);
    await assert.rejects(run, (error) => error === failures.at(-1));
    assert.equal(failures.length, 3);
    assert.equal(siblingAborted, true, "only the final failure may abort siblings");
    // No attempt, retried or not, counts as a completed fragment.
    assert.deepEqual(progress, [[0, 2]]);
});

test("runRequests abandons a pending retry when the parent signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during retry backoff");
    const attemptStarted = deferred();
    let attempts = 0;
    let settled = false;
    const run = runRequests(
        [contextWith(["a"])],
        () => {
            attempts++;
            attemptStarted.resolve();
            return Promise.reject(connectionReset());
        },
        1,
        controller.signal,
        () => undefined,
    );
    void run.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await attemptStarted.promise;
    await settleMicrotasks();
    assert.equal(settled, false, "a transient failure must leave the request waiting to retry");
    controller.abort(reason);
    await settleMicrotasks();
    assert.equal(settled, true, "cancellation must not wait for the retry backoff");
    await assert.rejects(run, (error) => error === reason);
    mock.timers.tick(500);
    await settleMicrotasks();
    assert.equal(attempts, 1, "an aborted run must not send another request");
});

const nonRetryableOutcomes: readonly [string, () => Promise<ClassifierResult>, RegExp][] = [
    [
        "a deterministic provider rejection",
        () => Promise.resolve(result({}, { stopReason: "error", errorMessage: "Unauthorized" })),
        /Jev error: Unauthorized/,
    ],
    [
        "an aborted provider result",
        () => Promise.resolve(result({}, { stopReason: "aborted" })),
        /Jev aborted/,
    ],
    [
        "an invalid answer",
        () => Promise.resolve(result({ a: { type: "bool", probability: 1.5 } })),
        /invalid probability/,
    ],
    [
        "a non-transport classifier failure",
        () => Promise.reject(new Error("invalid request: unsupported schema")),
        /invalid request/,
    ],
];
for (const [name, outcome, expected] of nonRetryableOutcomes)
    test(`runRequests does not retry ${name}`, async () => {
        let attempts = 0;
        await assert.rejects(
            runRequests(
                [contextWith(["a"])],
                () => {
                    attempts++;
                    return outcome();
                },
                1,
                new AbortController().signal,
                () => undefined,
            ),
            expected,
        );
        assert.equal(attempts, 1);
    });

test("runRequests keeps its other slots working while a request waits to retry", async () => {
    const contexts = ["a", "b", "c"].map((id) => contextWith([id]));
    const siblingStarted = deferred();
    const otherStarted = deferred();
    let attempts = 0;
    let active = 0;
    let maxActive = 0;
    const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
            if (id === "c") {
                otherStarted.resolve();
                return result({ c: { type: "bool", probability: 0.1 } });
            }
            if (id === "b") {
                siblingStarted.resolve();
                return result({ b: { type: "bool", probability: 0.1 } });
            }
            attempts++;
            if (attempts === 1) {
                // Hold the first attempt open so the sibling runs alongside it before the retry.
                await siblingStarted.promise;
                throw connectionReset();
            }
            return result({ a: { type: "bool", probability: 0.2 } });
        } finally {
            active--;
        }
    };
    const run = runRequests(contexts, classify, 2, new AbortController().signal, () => undefined);
    run.catch(() => undefined);
    // The slot freed by the completed sibling picks the third request while the first one waits.
    await otherStarted.promise;
    await settleMicrotasks();
    assert.equal(attempts, 1, "a retrying request must not serialize the pool");
    mock.timers.tick(500);
    const results = await run;
    assert.equal(maxActive, 2);
    assert.deepEqual(
        results.map((entry) => Object.keys(entry.answers)[0]),
        ["a", "b", "c"],
    );
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
