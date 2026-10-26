/**
 * Composition behind the native Pi entry.
 *
 * Settings and the Theme section go through Core's public APIs, so the section appears in
 * `/lune-core-settings` whenever Core's extension is loaded; the theme itself runs without it.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    bindSettings,
    readGlobalSettings,
    registerSettingsPanel,
    ResourceScope,
} from "@lune_99/pi-lune-extensions-core";
import { installSessionHandoff } from "./session-handoff.ts";
import { installStartupHeader, type StartupHeaderOptions } from "./startup-header.ts";
import { createLuneHeader, type HeaderOptions } from "./header.ts";
import { registerTheme } from "./index.ts";
import { createThemePanel } from "./panel.ts";
import { themeSettings } from "./settings.ts";

const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

interface ThemeHost extends Omit<HeaderOptions, "version"> {
    /** Optional: without Pi's class the header is applied at `session_start`, after its first frame. */
    readonly interactiveMode?: StartupHeaderOptions["interactiveMode"];
}

/**
 * The header renders before `session_start`, when project trust is not known yet, so only
 * global values apply here; the session binding applies project overrides afterwards.
 */
async function startupHeaderEnabled(): Promise<boolean> {
    const { enabled, showStartupHeader } = await readGlobalSettings(themeSettings);
    return enabled && showStartupHeader;
}

export function createThemeExtension({ interactiveMode, ...host }: ThemeHost) {
    return async function luneCoreTheme(pi: ExtensionAPI): Promise<void> {
        const resources = new ResourceScope();
        try {
            const handoff = installSessionHandoff(interactiveMode);
            resources.defer(
                pi.on("session_shutdown", (event) => {
                    // Teardown reads this to keep the appearance for the session that replaces this one.
                    handoff.leave(event.reason);
                    return resources.dispose();
                }),
            );
            const settings = resources.use(bindSettings(pi, themeSettings));
            const header = { version, ...host };
            const startupHeader = resources.use(
                installStartupHeader({
                    interactiveMode,
                    enabled: startupHeaderEnabled,
                    factory: (_tui, theme) => createLuneHeader(theme, header),
                }),
            );
            resources.use(registerSettingsPanel(createThemePanel(header), settings));
            resources.use(
                registerTheme(pi, settings, header, { startupHeader, handoff, interactiveMode }),
            );
        } catch (error) {
            await resources.dispose();
            throw error;
        }
    };
}
