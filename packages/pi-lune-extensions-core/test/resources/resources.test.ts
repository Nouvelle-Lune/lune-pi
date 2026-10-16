import assert from "node:assert/strict";
import { test } from "node:test";
import { ResourceScope as Resources } from "../../src/resources/index.ts";

test("resources release deduplicated instances and callbacks in reverse acquisition order", async () => {
    // Duplicate ownership must not dispose one resource twice, and later acquisitions release first.
    const releases: string[] = [];
    const owner = new Resources();
    const first = {
        dispose: () => {
            releases.push("first");
        },
    };
    const second = {
        dispose: () => {
            releases.push("second");
        },
    };

    assert.strictEqual(owner.use(first), first);
    owner.use(first);
    owner.defer(() => {
        releases.push("callback");
    });
    owner.use(second);
    await owner.dispose();

    assert.deepEqual(releases, ["second", "callback", "first"]);
});

test("resources finish all cleanup after failures and share the disposal promise", async () => {
    // Every releaser runs even after an error, and repeat disposal observes the same failure result.
    const releases: string[] = [];
    const firstFailure = new Error("first release failed");
    const secondFailure = new Error("second release failed");
    const owner = new Resources();
    owner.defer(() => {
        releases.push("first");
        throw firstFailure;
    });
    owner.defer(async () => {
        releases.push("second");
        throw secondFailure;
    });

    const disposal = owner.dispose();
    assert.strictEqual(owner.dispose(), disposal);
    await assert.rejects(disposal, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [secondFailure, firstFailure]);
        return true;
    });
    assert.deepEqual(releases, ["second", "first"]);
    assert.throws(() => owner.defer(() => undefined), /disposed/);
});

test("subscription releases are idempotent and run during owner disposal", async () => {
    // A caller may release early while owner cleanup remains safe and releases the subscription once.
    const releases: string[] = [];
    const owner = new Resources();
    const source = {
        subscribe(_listener: (value: number) => void) {
            return () => releases.push("unsubscribed");
        },
    };
    const unsubscribe = owner.subscribe(source, () => undefined);

    unsubscribe();
    unsubscribe();
    await owner.dispose();

    assert.deepEqual(releases, ["unsubscribed"]);
});

test("synchronous subscription callbacks can dispose the owner without leaking the subscription", async () => {
    // Registration may emit synchronously, so disposal during that emission must still capture cleanup.
    let activeSubscriptions = 0;
    let unsubscribeCount = 0;
    const owner = new Resources();
    const source = {
        subscribe(listener: (value: number) => void) {
            activeSubscriptions++;
            listener(1);
            return () => {
                activeSubscriptions--;
                unsubscribeCount++;
            };
        },
    };

    owner.subscribe(source, () => {
        void owner.dispose();
    });
    await owner.dispose();

    assert.equal(activeSubscriptions, 0);
    assert.equal(unsubscribeCount, 1);
});
