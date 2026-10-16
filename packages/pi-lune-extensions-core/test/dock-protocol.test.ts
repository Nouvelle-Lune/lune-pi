import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDockRegistry, getDockRegistry } from "../src/dock/host.ts";
import { LUNE_DOCK_PROTOCOL_VERSION } from "../src/dock/index.ts";
import type { LuneDockSnapshot } from "../src/dock/index.ts";
import type { DockContribution } from "../src/dock/host.ts";

function provider(id: string, onHostPresenceChange?: (present: boolean) => void) {
    let snapshot: LuneDockSnapshot = {
        base: { render: () => [id], invalidate() {} },
    };
    let listener: ((snapshot: LuneDockSnapshot) => void) | undefined;
    let unsubscribed = 0;
    const contribution: DockContribution = {
        id,
        getSnapshot: () => snapshot,
        subscribe(value) {
            listener = value;
            return () => {
                unsubscribed++;
            };
        },
        activate() {},
        onHostPresenceChange,
    };
    return {
        contribution,
        publish(next: LuneDockSnapshot) {
            snapshot = next;
            listener?.(next);
        },
        unsubscribed: () => unsubscribed,
    };
}

describe("Lune protocol", () => {
    it("isolates UI scopes and exposes the versioned host registration API", () => {
        const registry = createDockRegistry();
        const a = {},
            b = {};
        assert.equal(registry.getHost(a), undefined);
        const detach = registry.attachHost(a, { invalidate() {} });
        const host = registry.getHost(a)!;
        assert.equal(host.protocolVersion, LUNE_DOCK_PROTOCOL_VERSION);
        const release = host.register(provider("shell").contribution);
        assert.equal(registry.getContributions(a).length, 1);
        assert.equal(registry.getContributions(b).length, 0);
        release();
        detach();
        assert.equal(registry.getHost(a), undefined);
    });

    it("atomically replaces complete snapshots, removes missing levels, and ignores retired publishers", () => {
        const registry = createDockRegistry(),
            scope = {};
        const source = provider("shell");
        let invalidations = 0;
        registry.attachHost(scope, {
            invalidate() {
                invalidations++;
            },
        });
        const release = registry.registerContribution(scope, source.contribution);
        const full = {
            base: { render: () => ["2"], invalidate() {} },
            detail: { render: () => ["2 detail"], invalidate() {} },
            full: { render: () => ["2 full"], invalidate() {} },
        };
        source.publish(full);
        assert.strictEqual(registry.getContributions(scope)[0]!.snapshot, full);
        const base = { base: { render: () => ["3"], invalidate() {} } };
        source.publish(base);
        assert.strictEqual(registry.getContributions(scope)[0]!.snapshot, base);
        assert.equal(registry.getContributions(scope)[0]!.snapshot.full, undefined);
        release();
        assert.equal(source.unsubscribed(), 1);
        const before = invalidations;
        source.publish(full);
        assert.equal(invalidations, before);
        const replacement = provider("shell");
        registry.registerContribution(scope, replacement.contribution);
        release();
        assert.strictEqual(registry.getContributions(scope)[0]!.provider, replacement.contribution);
    });

    it("reads current truth on reattachment and initializes before subscribing", () => {
        const registry = createDockRegistry(),
            scope = {};
        const calls: string[] = [];
        let current = {
            base: { render: () => ["before restart"], invalidate() {} },
        };
        registry.registerContribution(scope, {
            id: "restored",
            getSnapshot() {
                calls.push("getSnapshot");
                return current;
            },
            subscribe() {
                calls.push("subscribe");
                return () => {};
            },
            activate() {},
        });
        assert.deepEqual(calls, ["getSnapshot", "subscribe"]);
        const detach = registry.attachHost(scope, { invalidate() {} });
        detach();
        current = {
            base: { render: () => ["after restoration"], invalidate() {} },
        };
        registry.attachHost(scope, { invalidate() {} });
        assert.strictEqual(registry.getContributions(scope)[0]!.snapshot, current);
    });

    it("notifies every contributor on transitions and rolls back failed host attachment", () => {
        const registry = createDockRegistry(),
            scope = {};
        const presence: string[] = [];
        registry.registerContribution(
            scope,
            provider("broken", (present) => {
                presence.push(`broken:${present}`);
                if (present) throw new Error("setup failed");
            }).contribution,
        );
        registry.registerContribution(
            scope,
            provider("healthy", (present) => presence.push(`healthy:${present}`)).contribution,
        );
        assert.throws(() => registry.attachHost(scope, { invalidate() {} }), AggregateError);
        assert.equal(registry.hasHost(scope), false);
        assert.deepEqual(presence, [
            "broken:false",
            "healthy:false",
            "broken:true",
            "healthy:true",
            "broken:false",
            "healthy:false",
        ]);
    });

    it("rejects duplicate ownership and cleans up failed initial providers", () => {
        const registry = createDockRegistry(),
            scope = {};
        registry.registerContribution(scope, provider("shell").contribution);
        assert.throws(
            () => registry.registerContribution(scope, provider("shell").contribution),
            /Duplicate/,
        );
        const broken = provider("broken").contribution;
        broken.getSnapshot = () => {
            throw new Error("snapshot failed");
        };
        assert.throws(() => registry.registerContribution(scope, broken), /snapshot failed/);
        assert.equal(registry.getContributions(scope).length, 1);
        const brokenPresence = provider("presence", () => {
            throw new Error("presence failed");
        });
        assert.throws(
            () => registry.registerContribution(scope, brokenPresence.contribution),
            /presence failed/,
        );
        assert.equal(brokenPresence.unsubscribed(), 1);
        const detach = registry.attachHost(scope, { invalidate() {} });
        assert.throws(() => registry.attachHost(scope, { invalidate() {} }), /already attached/);
        detach();
        registry.attachHost(scope, { invalidate() {} });
        detach();
        assert.equal(registry.hasHost(scope), true);
    });

    it("shares discovery across installed copies", async () => {
        const duplicate = await import(new URL("../src/dock/host.ts?copy=1", import.meta.url).href);
        assert.strictEqual(duplicate.getDockRegistry(), getDockRegistry());
    });
});
