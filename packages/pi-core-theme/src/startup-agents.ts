import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Container, type TUI } from "@earendil-works/pi-tui";

interface ListingOptions {
    force?: boolean;
}

interface ResourceMode {
    loadedResourcesContainer: Container;
    ui: Pick<TUI, "requestRender">;
    shouldShowStartupDetails(): boolean;
    getStartupExpansionState(): boolean;
}

type ShowLoadedResources = (this: ResourceMode, options?: ListingOptions) => void;

/** Pi has no public API for appending to its startup resource list. */
export function installStartupAgents({
    interactiveMode,
    events,
    getTheme,
}: {
    interactiveMode: { prototype: object } | undefined;
    events: ExtensionAPI["events"];
    getTheme: () => Theme | undefined;
}): { dispose(): void } {
    const prototype = interactiveMode?.prototype as
        | { showLoadedResources?: ShowLoadedResources }
        | undefined;
    if (!prototype || typeof prototype.showLoadedResources !== "function") {
        return { dispose() {} };
    }
    let names: readonly string[] = [];
    // Factories run before session_start, so either extension load order receives the names.
    const stop = events.on("lune-subagent:agents-loaded", (data) => {
        names = data as readonly string[];
    });
    let expanded = false;
    const text = new Text("", 0, 0);
    const section = {
        setExpanded(value: boolean) {
            expanded = value;
        },
        invalidate() {
            text.invalidate();
        },
        render(width: number): string[] {
            const theme = getTheme();
            if (!theme || names.length === 0) return [];
            const body = expanded
                ? names.map((name) => `  ${name}`).join("\n")
                : `  ${names.join(", ")}`;
            text.setText(`${theme.fg("mdHeading", "[Agents]")}\n${theme.fg("dim", body)}`);
            return [...text.render(width), ""];
        },
    };
    let unmount: (() => void) | undefined;
    const original = prototype.showLoadedResources;
    const show: ShowLoadedResources = function (options) {
        original.call(this, options);
        unmount = undefined;
        if (!(options?.force || this.shouldShowStartupDetails())) return;
        expanded = this.getStartupExpansionState();
        this.loadedResourcesContainer.addChild(section);
        unmount = () => {
            this.loadedResourcesContainer.removeChild(section);
            this.ui.requestRender();
        };
    };
    prototype.showLoadedResources = show;
    return {
        dispose() {
            stop();
            names = [];
            if (prototype.showLoadedResources === show) prototype.showLoadedResources = original;
            unmount?.();
            unmount = undefined;
        },
    };
}
