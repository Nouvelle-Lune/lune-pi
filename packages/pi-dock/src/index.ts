import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    bindSettings,
    registerSettingsPanel,
    scopedExtension,
} from "@lune_99/pi-lune-extensions-core";
import { openSettingsPanel } from "@lune_99/pi-lune-extensions-core/panel/tui";
import { DockController } from "./dock-controller.ts";
import { dockPanel } from "./dock-panel.ts";
import { dockSettings } from "./dock-settings.ts";

export default scopedExtension((pi, resources) => {
    const dock = new DockController();
    const settings = resources.use(bindSettings(pi, dockSettings));
    resources.use(registerSettingsPanel(dockPanel, settings));
    // Dock teardown runs before the borrowed settings' own shutdown.
    resources.defer(() => dock.detach());

    resources.defer(
        pi.on("session_start", async (_event, ctx: ExtensionContext) => {
            dock.detach();
            let attached = false;
            const view = await settings.view(ctx);
            const apply = () => {
                const { enabled, ...appearance } = view.snapshot();
                dock.configure(appearance);
                // Re-attaching would drop focus and the cell window, so only enabling or disabling does it.
                if (enabled && !attached) dock.attach(ctx);
                else if (!enabled && attached) dock.detach();
                attached = enabled;
            };
            apply();
            // Style, visibility and enabling take effect without a restart; the view retires the subscription.
            view.subscribe(apply);
        }),
    );
    resources.defer(pi.on("session_before_tree", () => dock.resetInteraction()));
    resources.defer(pi.on("session_tree", () => dock.invalidate()));

    pi.registerCommand("dock", {
        description: "Open Lune Dock settings",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("Dock settings require interactive TUI mode", "warning");
                return;
            }
            await openSettingsPanel(ctx, { section: dockPanel.id });
        },
    });
});
