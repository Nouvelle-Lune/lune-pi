import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    bindSettings,
    registerSettingsPanel,
    ResourceScope,
} from "@lune_99/pi-lune-extensions-core";
import { recapSettings, type RecapSettingsView } from "./settings.ts";
import { recapPanel } from "./panel.ts";
import { RecapRuntime } from "./runtime.ts";

export function registerRecap(pi: ExtensionAPI): { dispose(): Promise<void> } {
    const resources = new ResourceScope();
    let current: { view: RecapSettingsView; runtime: RecapRuntime } | undefined;
    let closed = false;
    const handle = {
        dispose() {
            closed = true;
            return resources.dispose();
        },
    };
    // Business teardown runs before the borrowed settings' automatic shutdown.
    resources.defer(pi.on("session_shutdown", () => handle.dispose()));
    try {
        const settings = resources.use(bindSettings(pi, recapSettings));
        resources.use(registerSettingsPanel(recapPanel, settings));
        resources.defer(() => {
            const previous = current;
            current = undefined;
            previous?.runtime.dispose();
        });
        const runtime = async (ctx: ExtensionContext) => {
            const view = await settings.view(ctx);
            // Settings is released last; fence startup as soon as business disposal begins.
            if (closed) throw new DOMException("Recap is disposed", "AbortError");
            view.signal.throwIfAborted();
            if (current?.view !== view) {
                const previous = current;
                current = undefined;
                previous?.runtime.dispose();
                current = { view, runtime: new RecapRuntime(pi, ctx, view) };
            }
            return current.runtime;
        };
        pi.registerCommand("recap", {
            description: "Show a one-line recap of the current session",
            handler: async (_args, ctx) => (await runtime(ctx)).manual(ctx),
        });
        const invalidate = async (_event: unknown, ctx: ExtensionContext) =>
            (await runtime(ctx)).input(ctx);
        const branchChanged = async (_event: unknown, ctx: ExtensionContext) =>
            (await runtime(ctx)).branchChanged(ctx);
        const subscriptions = [
            () =>
                pi.on("session_start", async (_event, ctx) => {
                    await runtime(ctx);
                }),
            () => pi.on("input", invalidate),
            () => pi.on("agent_start", async (_event, ctx) => (await runtime(ctx)).start(ctx)),
            () =>
                pi.on("agent_before_settle", async (event, ctx) =>
                    (await runtime(ctx)).beforeSettle(event.outcome, ctx),
                ),
            () => pi.on("agent_settled", async (_event, ctx) => (await runtime(ctx)).settled(ctx)),
            () =>
                pi.on("ui_prompt_start", async (_event, ctx) =>
                    (await runtime(ctx)).prompt(true, ctx),
                ),
            () =>
                pi.on("ui_prompt_end", async (_event, ctx) =>
                    (await runtime(ctx)).prompt(false, ctx),
                ),
            // Observation does not veto navigation or replace Pi's compaction result.
            () => pi.on("session_before_switch", invalidate),
            () => pi.on("session_before_fork", invalidate),
            () => pi.on("session_before_tree", invalidate),
            () => pi.on("session_before_compact", invalidate),
            () => pi.on("session_tree", branchChanged),
            () => pi.on("session_compact", branchChanged),
            () => pi.on("model_select", invalidate),
        ];
        // Own each registration immediately so a later setup failure cannot leak earlier hooks.
        for (const subscribe of subscriptions) resources.defer(subscribe());
    } catch (error) {
        closed = true;
        void resources.dispose().catch(() => {});
        throw error;
    }
    return handle;
}

export default function extension(pi: ExtensionAPI): void {
    registerRecap(pi);
}
