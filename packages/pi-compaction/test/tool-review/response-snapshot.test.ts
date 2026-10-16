import test from "node:test";
import assert from "node:assert/strict";
import type {
    ClassifierContext,
    ClassifierQuestion,
    ClassifierResult,
} from "@earendil-works/pi-ai";
import { runRequests } from "../../src/tool-review/classification.ts";
import { policy } from "../harness/fixtures.ts";

function question(id: string): ClassifierQuestion {
    return { type: "bool", instructions: id, criteria: { true: "yes", false: "no" } };
}

function contextWith(ids: string[]): ClassifierContext {
    return { state: {}, questions: Object.fromEntries(ids.map((id) => [id, question(id)])) };
}

function result(answers: Record<string, { type: "bool"; probability: number }>): ClassifierResult {
    return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev",
        answers,
        stopReason: "stop",
        timestamp: 0,
    };
}

test("runRequests snapshots provider results so a reused response object cannot overwrite an earlier request's answer", async () => {
    const contexts = [contextWith(["a"]), contextWith(["b"])];
    // The provider keeps one mutable object and rewrites its answers per request, as a caching transport can.
    const shared = result({});
    let calls = 0;
    let firstCompleted!: () => void;
    const firstSnapshot = new Promise<void>((resolve) => {
        firstCompleted = resolve;
    });
    const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        // Reuse happens after the first response has been consumed, as a sequential transport would.
        if (id === "b") await firstSnapshot;
        calls++;
        shared.answers = { [id]: { type: "bool", probability: calls * 0.1 } };
        return shared;
    };

    const results = await runRequests(
        contexts,
        classify,
        new AbortController().signal,
        (completed) => {
            if (completed === 1) firstCompleted();
        },
    );

    assert.equal(results.length, 2);
    assert.equal(
        (results[0]!.answers.a as { probability: number }).probability,
        0.1,
        "the first result must retain its own answer",
    );
    assert.equal(
        (results[1]!.answers.b as { probability: number }).probability,
        0.2,
        "the second result must retain its own answer",
    );

    // Mutating the provider's reused object after the run must not reach the retained snapshots.
    shared.answers = {};
    assert.equal(
        (results[0]!.answers.a as { probability: number }).probability,
        0.1,
        "later mutation must not turn a saved probability into a missing answer",
    );
    assert.equal(
        Number.isFinite((results[0]!.answers.a as { probability: number }).probability),
        true,
    );
    assert.equal((results[1]!.answers.b as { probability: number }).probability, 0.2);
});

test("runRequests still validates the snapshot of a reused response object before retaining it", async () => {
    const shared = result({});
    const classify = (context: ClassifierContext): Promise<ClassifierResult> => {
        const id = Object.keys(context.questions)[0]!;
        shared.answers = { [id]: { type: "bool", probability: Number.NaN } };
        return Promise.resolve(shared);
    };

    await assert.rejects(
        runRequests([contextWith(["a"])], classify, new AbortController().signal, () => undefined),
        /invalid probability/,
    );
});
