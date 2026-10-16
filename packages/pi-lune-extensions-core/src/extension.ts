/**
 * Optional Pi package entry for the shared command and Core's own settings section.
 *
 * SDK consumers do not need this extension for Host discovery or settings storage.
 * Consumer plugins register their own sections; this entry owns only Core's Settings
 * binding and Panel registration. It opts into /panel/tui and terminal peers.
 */
import { corePanel } from "./core/panel.ts";
import { coreSettings } from "./core/settings.ts";
import { registerSettingsPanel } from "./panel/registration.ts";
import { openSettingsPanel } from "./panel/tui.ts";
import { scopedExtension } from "./resources/scoped-extension.ts";
import { bindSettings } from "./settings/binding.ts";

/**
 * Register the shared command without acquiring any consumer's configuration.
 *
 * An optional trimmed argument selects a registered section ID. RPC/print callers
 * receive a warning instead of opening terminal UI; unknown TUI sections propagate
 * the renderer's error rather than silently choosing another extension.
 */
export default scopedExtension((pi, resources) => {
    const settings = resources.use(bindSettings(pi, coreSettings));
    resources.use(registerSettingsPanel(corePanel, settings));
    pi.registerCommand("lune-core-settings", {
        description: "Open unified Lune extension settings with TUI previews",
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("Lune settings require interactive TUI mode", "warning");
                return;
            }
            await openSettingsPanel(ctx, { section: args.trim() || undefined });
        },
    });
});
