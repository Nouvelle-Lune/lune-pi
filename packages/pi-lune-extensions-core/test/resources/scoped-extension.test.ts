import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scopedExtension } from "../../src/resources/index.ts";

function fakePi() {
    const handlers = new Map<string, Set<() => unknown>>();
    const pi = {
        on(name: string, handler: () => unknown) {
            const group = handlers.get(name) ?? new Set();
            group.add(handler);
            handlers.set(name, group);
            return () => group.delete(handler);
        },
    } as unknown as ExtensionAPI;
    return {
        pi,
        count: (name: string) => handlers.get(name)?.size ?? 0,
        emit: async (name: string) => {
            for (const handler of [...(handlers.get(name) ?? [])]) await handler();
        },
    };
}

test("resources are disposed in reverse order on session_shutdown and the hook is removed", async () => {
    const bridge = fakePi();
    const disposed: string[] = [];

    await scopedExtension(async (_pi, resources) => {
        await Promise.resolve();
        resources.defer(() => void disposed.push("first"));
        resources.defer(() => void disposed.push("second"));
    })(bridge.pi);

    assert.equal(bridge.count("session_shutdown"), 1);
    assert.deepEqual(disposed, []);
    await bridge.emit("session_shutdown");
    assert.deepEqual(disposed, ["second", "first"]);
    assert.equal(bridge.count("session_shutdown"), 0);
});

test("a failing setup disposes what was acquired and rethrows the setup error", async () => {
    const bridge = fakePi();
    const disposed: string[] = [];
    const failure = new Error("setup failed");

    await assert.rejects(
        scopedExtension((_pi, resources) => {
            resources.defer(() => void disposed.push("first"));
            resources.defer(() => void disposed.push("second"));
            throw failure;
        })(bridge.pi),
        (error) => error === failure,
    );

    assert.deepEqual(disposed, ["second", "first"]);
    assert.equal(bridge.count("session_shutdown"), 0);
});

test("a cleanup failure during failed setup is aggregated with the setup error", async () => {
    const bridge = fakePi();
    const failure = new Error("setup failed");
    const cleanupFailure = new Error("cleanup failed");
    let otherDisposed = false;

    await assert.rejects(
        scopedExtension((_pi, resources) => {
            resources.defer(() => void (otherDisposed = true));
            resources.defer(() => {
                throw cleanupFailure;
            });
            throw failure;
        })(bridge.pi),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /Extension setup and cleanup failed/);
            const actual = error.errors;
            assert.equal(actual[0], failure);
            assert.ok(actual[1] instanceof AggregateError);
            assert.deepEqual(actual[1].errors, [cleanupFailure]);
            return true;
        },
    );
    assert.equal(otherDisposed, true);
});
