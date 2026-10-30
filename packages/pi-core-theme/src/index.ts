import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SettingsBinding, SettingsView } from "@lune_99/pi-lune-extensions-core";
import type { HeaderFactory, StartupHeader } from "./startup-header.ts";
import type { SessionHandoff } from "./session-handoff.ts";
import { createLuneHeader, type HeaderOptions } from "./header.ts";
import { installStartupAgents } from "./startup-agents.ts";
import { config, setConfig } from "./config/config.ts";
import type { themeSettings } from "./settings.ts";
import { capturePalette, createPalette } from "./palette.ts";
import { isPaletteName, palettes, type PaletteName } from "./palettes/index.ts";
import { setTerminalColors, type TerminalWriter } from "./terminal-background.ts";
import { createThemeRendererHost } from "./renderer/index.ts";
import markdownEnhance, { clearMarkdownCache } from "./renderer/markdown-enhance.ts";
import { shikiHighlightCache } from "./renderer/tool/diff/shiki-highlight.ts";
import contextInspector from "./feature/context.ts";
import {
    createWriteMetadataAdapter,
    WriteExecutionMetadataStore,
} from "./renderer/tool/diff/write-execution.ts";

/** Settings owns activation; headless sessions never mount appearance or transcript renderers. */
export function registerTheme(
    pi: ExtensionAPI,
    settings: SettingsBinding<typeof themeSettings.schema>,
    header: HeaderOptions,
    continuity: {
        startupHeader?: Pick<StartupHeader, "claim">;
        handoff?: SessionHandoff;
        interactiveMode?: { prototype: object };
    } = {},
) {
    const { startupHeader, handoff, interactiveMode } = continuity;
    const headerFactory: HeaderFactory = (_tui, theme) => createLuneHeader(theme, header);
    let release: (() => void) | undefined;
    let disposed = false;
    let enabledInTui = false;
    let currentContext: ExtensionContext | undefined;
    const startupAgents = installStartupAgents({
        interactiveMode,
        events: pi.events,
        getTheme: () => (enabledInTui ? currentContext?.ui.theme : undefined),
    });
    const writeMetadata = new WriteExecutionMetadataStore();
    const rendererHost = createThemeRendererHost(pi, writeMetadata, () =>
        header.keyText("app.tools.expand"),
    );
    const writes = createWriteMetadataAdapter(
        pi,
        writeMetadata,
        () => enabledInTui && config.mode !== "off",
    );
    if (typeof pi.registerMarkdownTransformer === "function")
        markdownEnhance(pi, () => enabledInTui);
    contextInspector(pi, async (ctx) => (await settings.view(ctx)).get("enabled"));
    const unmount = () => {
        const previous = release;
        release = undefined;
        previous?.();
    };
    const mount = (context: ExtensionContext, view: SettingsView<typeof themeSettings.schema>) => {
        unmount();
        if (disposed || view.signal.aborted || context.mode !== "tui") return;
        currentContext = context;
        // The header and palette already on screen came from the startup swap or the previous
        // instance; apply() only changes them if settings disagree.
        const adopted = handoff?.adopt() ?? {};
        let headerEnabled = (startupHeader?.claim() ?? false) || !!adopted.header;
        let renderer: ReturnType<typeof rendererHost.mount> | undefined;
        let writeTimer: ReturnType<typeof setTimeout> | undefined;
        let previousTheme: Theme | undefined = adopted.palette?.native;
        let appliedPalette: string | undefined = adopted.palette?.name;
        let appliedTheme: Theme | undefined = adopted.palette?.applied;
        let snapshot = "";
        const track = () =>
            handoff?.track({
                header: headerEnabled ? headerFactory : undefined,
                palette:
                    previousTheme && appliedPalette && appliedTheme
                        ? { name: appliedPalette, applied: appliedTheme, native: previousTheme }
                        : undefined,
            });
        const paletteWidgetKey = "pi-core-theme-palette";
        let paletteMounted = false;
        let paletteQueued = false;
        let paletteFailed = false;
        // Captured from the palette widget, the only surface that hands extensions Pi's TUI.
        let terminal: TerminalWriter | undefined;
        const syncTerminalColors = () => {
            const vars =
                isPaletteName(appliedPalette) && view.get("paletteBackground")
                    ? palettes[appliedPalette].definition.vars
                    : undefined;
            // An empty bg means the palette leaves the page to the terminal; painting an empty
            // OSC 11 value would clear the profile color that a previous palette replaced.
            setTerminalColors(
                terminal,
                vars?.bg ? { background: vars.bg, foreground: vars.text } : undefined,
            );
        };
        const applyPalette = (name: PaletteName) => {
            previousTheme ??= capturePalette(context.ui.theme, (name) => context.ui.getTheme(name));
            const palette = createPalette(name, context.ui.theme);
            const result = context.ui.setTheme(palette);
            if (!result.success) throw new Error(result.error);
            appliedPalette = name;
            appliedTheme = palette;
            syncTerminalColors();
            track();
        };
        const reconcilePalette = () => {
            if (
                !paletteMounted ||
                paletteQueued ||
                paletteFailed ||
                context.ui.theme.name === appliedPalette
            )
                return;
            paletteQueued = true;
            // Native /reload applies Pi's theme after session_start; never change themes inside render.
            queueMicrotask(() => {
                paletteQueued = false;
                if (!paletteMounted || view.signal.aborted || !view.get("enabled")) return;
                const name = view.get("palette");
                if (name === "inherit" || context.ui.theme.name === name) return;
                try {
                    applyPalette(name);
                } catch (error) {
                    paletteFailed = true;
                    context.ui.notify(`Lune palette: ${String(error)}`, "error");
                }
            });
        };
        const restorePalette = () => {
            if (previousTheme && context.ui.theme?.name === appliedPalette) {
                const result = context.ui.setTheme(previousTheme);
                if (!result.success) throw new Error(result.error);
            }
            previousTheme = undefined;
            appliedPalette = undefined;
            appliedTheme = undefined;
            syncTerminalColors();
        };
        const apply = () => {
            const enabled = view.get("enabled");
            const next = {
                ...view.snapshot(),
                excludeRenderers: [...view.get("excludeRenderers")],
            };
            const key = JSON.stringify([enabled, next]);
            if (key === snapshot) return;
            const showHeader = enabled && next.showStartupHeader;
            if (showHeader !== headerEnabled) {
                context.ui.setHeader(showHeader ? headerFactory : undefined);
                headerEnabled = showHeader;
            }
            paletteFailed = false;
            if (!enabled || next.palette === "inherit") restorePalette();
            else if (next.palette !== appliedPalette || context.ui.theme.name !== next.palette)
                applyPalette(next.palette);
            const watchPalette =
                enabled &&
                next.palette !== "inherit" &&
                context.hasUI &&
                typeof context.ui.setWidget === "function";
            if (watchPalette !== paletteMounted) {
                paletteMounted = watchPalette;
                context.ui.setWidget(
                    paletteWidgetKey,
                    watchPalette
                        ? (tui: { terminal: TerminalWriter }) => {
                              terminal = tui.terminal;
                              return {
                                  render() {
                                      reconcilePalette();
                                      return [];
                                  },
                                  invalidate() {},
                              };
                          }
                        : undefined,
                );
            }
            syncTerminalColors();
            // TUI fixtures and SDK bindings may expose only a header, not a transcript surface.
            enabledInTui = enabled && context.hasUI && typeof context.ui.setWidget === "function";
            if (enabledInTui) setConfig(next);
            const renderTools = enabledInTui && next.mode !== "off";
            if (!renderTools) {
                renderer?.dispose();
                renderer = undefined;
                if (writeTimer) clearTimeout(writeTimer);
                writeTimer = undefined;
            } else {
                if (renderer) renderer.update();
                else renderer = rendererHost.mount(context);
                if (!writes.owns() && !writeTimer) {
                    // Resolve ownership only after all extensions finish their startup hooks.
                    writeTimer = setTimeout(() => {
                        writeTimer = undefined;
                        if (!enabledInTui || view.signal.aborted) return;
                        try {
                            writes.ensure(context);
                        } catch (error) {
                            context.ui.notify(`Lune write diff: ${String(error)}`, "error");
                        }
                    }, 0);
                    writeTimer.unref();
                }
            }
            track();
            snapshot = key;
        };
        const stop = view.subscribe(apply);
        // Session replacement and shutdown retire the view before any later session mounts.
        view.signal.addEventListener("abort", unmount, { once: true });
        release = () => {
            view.signal.removeEventListener("abort", unmount);
            stop();
            if (writeTimer) clearTimeout(writeTimer);
            enabledInTui = false;
            currentContext = undefined;
            if (paletteMounted) {
                paletteMounted = false;
                context.ui.setWidget(paletteWidgetKey, undefined);
            }
            renderer?.dispose();
            writeMetadata.clear();
            clearMarkdownCache();
            shikiHighlightCache.clear();
            // A replacement session mounts next and adopts the header and palette; restoring Pi's
            // would show them natively for the whole rebuild.
            if (handoff?.handingOver) return;
            if (headerEnabled) context.ui.setHeader(undefined);
            restorePalette();
            handoff?.track({});
        };
        apply();
    };
    // The binding registered its own startup hook first, so the view resolves after acquisition.
    const unsubscribe = pi.on("session_start", async (_event, context) => {
        mount(context, await settings.view(context));
    });
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            unmount();
            startupAgents.dispose();
        },
    };
}
