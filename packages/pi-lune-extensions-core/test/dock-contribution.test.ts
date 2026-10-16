import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDockContribution, type IndependentDock } from "../src/dock/index.ts";
import { getDockRegistry } from "../src/dock/host.ts";
import { getCoreHost } from "../src/core/host.ts";

function fixture() {
    const writes: object[] = [];
    let ctx: ExtensionContext | undefined;
    let clears = 0;
    const standalone: IndependentDock = {
        setCtx(value) {
            ctx = value;
        },
        render() {
            if (ctx) writes.push(ctx.ui);
        },
        clear() {
            clears++;
            if (ctx) writes.push(ctx.ui);
        },
    };
    const handle = createDockContribution({
        id: "fixture",
        getSnapshot: () => ({
            base: { render: () => ["fixture"], invalidate() {} },
        }),
        activate: () => undefined,
        standalone,
    });
    const context = (mode = "tui") => ({ ui: {}, mode }) as ExtensionContext;
    return { handle, writes, context, cleared: () => clears };
}

describe("contributor adapter", () => {
    it("preserves independent rendering and switches immediately as a host enables or disables", () => {
        // Contract: both startup orders use presence alone to select the display owner.
        const { handle, writes, context } = fixture();
        const ctx = context();
        handle.attach(ctx);
        assert.equal(writes.length, 1);
        let invalidations = 0;
        const release = getDockRegistry().attachHost(ctx.ui, {
            invalidate: () => invalidations++,
        });
        const afterActivation = writes.length;
        const initialInvalidations = invalidations;
        handle.refresh();
        assert.equal(writes.length, afterActivation);
        assert.equal(invalidations, initialInvalidations + 1);
        handle.refresh({ summaryChanged: false });
        assert.equal(invalidations, initialInvalidations + 1);
        release();
        assert.equal(writes.length, afterActivation + 1);
        handle.refresh({ summaryChanged: false });
        assert.equal(writes.length, afterActivation + 2);
        handle.detach();
    });

    it("clears independent UI when the host was loaded first and delegates panel opening", () => {
        // Contract: a contributor loaded after the host never renders an independent status row.
        const { handle, context, cleared } = fixture();
        const ctx = context();
        const release = getDockRegistry().attachHost(ctx.ui, { invalidate() {} });
        handle.attach(ctx);
        assert.equal(cleared(), 1);
        assert.equal(getDockRegistry().getContributions(ctx.ui).length, 1);
        getDockRegistry().getContributions(ctx.ui)[0]!.provider.activate();
        handle.detach();
        release();
    });

    it("replaces and retires scopes without writing to the old UI and releases twice safely", () => {
        // Contract: retiring a context still stops timers through clear, but never writes to it.
        const { handle, context, writes, cleared } = fixture();
        const first = context();
        const second = context();
        handle.attach(first);
        const previousWrites = writes.filter((ui) => ui === first.ui).length;
        handle.attach(second);
        assert.equal(writes.filter((ui) => ui === first.ui).length, previousWrites);
        assert.equal(getDockRegistry().getContributions(first.ui).length, 0);
        assert.equal(getDockRegistry().getContributions(second.ui).length, 1);
        handle.detach({ retired: true });
        assert.equal(cleared(), 2);
        const count = writes.length;
        handle.detach();
        handle.refresh();
        assert.equal(writes.length, count);
    });

    it("keeps non-TUI use independent and reports rendering failures without claiming registration", () => {
        // Contract: non-TUI contexts do not register; initialization errors propagate explicitly.
        const { handle, context } = fixture();
        const ctx = context("rpc");
        handle.attach(ctx);
        assert.equal(getDockRegistry().getContributions(ctx.ui).length, 0);
        handle.detach();
        const broken = createDockContribution({
            id: "broken",
            getSnapshot: () => ({
                base: { render: () => ["broken"], invalidate() {} },
            }),
            activate() {},
            standalone: {
                setCtx() {},
                render() {
                    throw new Error("render failed");
                },
                clear() {},
            },
        });
        const tui = context();
        assert.throws(() => broken.attach(tui), /render failed/);
        assert.equal(getDockRegistry().getContributions(tui.ui).length, 0);
        broken.detach();
    });
});

describe("contributor adapter with an incompatible shared host", () => {
    const hostKey = Symbol.for("@lune_99/pi-lune-extensions-core/host");

    // Replaces the process-wide host for one callback; the real one is always restored.
    function withIncompatibleHost<T>(run: () => T): T {
        getCoreHost();
        const original = Object.getOwnPropertyDescriptor(globalThis, hostKey)!;
        Object.defineProperty(globalThis, hostKey, {
            value: { protocolVersion: -1 },
            configurable: true,
        });
        try {
            return run();
        } finally {
            Object.defineProperty(globalThis, hostKey, original);
        }
    }

    function notifying() {
        const notifications: [string, string | undefined][] = [];
        const { handle, writes, cleared } = fixture();
        const ctx = {
            mode: "tui",
            ui: { notify: (message: string, type?: string) => notifications.push([message, type]) },
        } as unknown as ExtensionContext;
        return { handle, writes, cleared, ctx, notifications };
    }

    it("is constructed without touching the registry", () => {
        assert.doesNotThrow(() => withIncompatibleHost(() => fixture()));
    });

    it("keeps the standalone view and warns instead of throwing when discovery fails", () => {
        const { handle, writes, ctx, notifications } = notifying();

        withIncompatibleHost(() => handle.attach(ctx));

        assert.equal(writes.length, 1);
        assert.equal(notifications.length, 1);
        const [message, type] = notifications[0]!;
        assert.equal(type, "warning");
        assert.match(
            message,
            /^Dock "fixture" is showing its standalone view: Incompatible Lune Core Host protocol/,
        );
        assert.equal(getDockRegistry().getContributions(ctx.ui).length, 0);
        handle.refresh();
        assert.equal(writes.length, 2);
        handle.detach();
    });

    it("discovers the registry on each attach, so a later compatible host is used", () => {
        const { handle, ctx, notifications } = notifying();
        withIncompatibleHost(() => handle.attach(ctx));
        handle.detach();

        handle.attach(ctx);

        assert.equal(notifications.length, 1);
        assert.equal(getDockRegistry().getContributions(ctx.ui).length, 1);
        handle.detach();
        assert.equal(getDockRegistry().getContributions(ctx.ui).length, 0);
    });

    it("does not consult the registry or warn outside the TUI", () => {
        const { handle, ctx, notifications } = notifying();
        const rpc = { ...ctx, mode: "rpc" } as ExtensionContext;

        withIncompatibleHost(() => handle.attach(rpc));

        assert.deepEqual(notifications, []);
        handle.detach();
    });

    it("forgets the registry on detach so a later incompatible host cannot affect it", () => {
        const { handle, ctx, writes } = notifying();
        handle.attach(ctx);
        handle.detach();
        const before = writes.length;

        assert.doesNotThrow(() =>
            withIncompatibleHost(() => {
                handle.refresh();
                handle.detach();
            }),
        );
        assert.equal(writes.length, before);
    });
});
