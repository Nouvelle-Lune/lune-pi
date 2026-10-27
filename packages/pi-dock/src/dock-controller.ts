import {
    CustomEditor,
    type ExtensionContext,
    type ReadonlyFooterDataProvider,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    isKeyRelease,
    matchesKey,
    type Component,
    type TuiMainScreen,
    type TuiAltScreen,
} from "@earendil-works/pi-tui";
import { getDockRegistry, type DockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";
import type { LuneDockDisplayMode } from "@lune_99/pi-lune-extensions-core/dock";
import {
    DockFooter,
    replacesFooter,
    type DockFooterInput,
    type DockLayout,
} from "./dock-footer.ts";
import type { VisibleDockItem } from "./dock-renderer.ts";
import { DockStatusSource, type DockMessageEvent, type DockStatus } from "./dock-status.ts";

export const WIDGET_ID = "pi-dock";

export class DockComponent implements Component {
    private isFocused = false;
    private readonly controller: DockController;
    private readonly theme: Theme;

    constructor(controller: DockController, theme: Theme) {
        this.controller = controller;
        this.theme = theme;
    }

    get focused(): boolean {
        return this.isFocused;
    }

    set focused(value: boolean) {
        this.isFocused = value;
        if (value) this.controller.onFocusRestored(this);
    }

    render(width: number): string[] {
        const input = this.controller.footerInput(this.focused);
        return input ? this.controller.view.render(width, this.theme, input) : [];
    }

    handleInput(data: string): void {
        this.controller.handleFocusedInput(data);
    }

    invalidate(): void {
        this.controller.invalidateSnapshots();
    }

    dispose(): void {
        this.controller.releaseComponent(this);
    }
}

/** The part of the dock settings the controller acts on; enabling and disabling belong to the caller. */
export interface DockControllerSettings extends DockLayout {
    displayMode: LuneDockDisplayMode;
    hidden: readonly string[];
    order: Readonly<Record<string, number>>;
}

export class DockController {
    items: readonly VisibleDockItem[] = [];
    selectedId: string | undefined;
    displayMode: LuneDockDisplayMode = "detail";
    private layout: DockLayout = {
        style: "ruled",
        showModel: true,
        showWorkspace: true,
        showUsage: true,
    };
    private hidden: ReadonlySet<string> = new Set();
    private order: Readonly<Record<string, number>> = {};

    configure(settings: DockControllerSettings): void {
        const tookFooter = replacesFooter(this.layout.style);
        this.displayMode = settings.displayMode;
        this.layout = {
            style: settings.style,
            showModel: settings.showModel,
            showWorkspace: settings.showWorkspace,
            showUsage: settings.showUsage,
        };
        this.hidden = new Set(settings.hidden);
        this.order = settings.order;
        // Only a style switch touches the footer, so an unrelated setting never reclaims it from another extension.
        if (this.ctx && tookFooter !== replacesFooter(this.layout.style)) this.syncFooter();
        this.refresh();
    }

    invalidateSnapshots(): void {
        if (!this.ctx) return;
        const components = new Set<Component>();
        for (const { snapshot } of this.registry.getContributions(this.ctx.ui)) {
            components.add(snapshot.base);
            if (snapshot.detail) components.add(snapshot.detail);
            if (snapshot.full) components.add(snapshot.full);
        }
        for (const component of components) component.invalidate();
    }
    /** Owned by the controller, not the component: the widget factory may build a new component at any time. */
    readonly view = new DockFooter();
    private ctx: ExtensionContext | undefined;
    private footerData: ReadonlyFooterDataProvider | undefined;
    private footerMounted = false;
    private tui: TuiMainScreen | TuiAltScreen | undefined;
    private component: DockComponent | undefined;
    private editor: Component | undefined;
    private releaseHost: (() => void) | undefined;
    private unsubscribeInput: (() => void) | undefined;
    private queuedGeneration: number | undefined;
    private generation = 0;
    private opening = false;
    private readonly registry: DockRegistry;
    private readonly statusSource: DockStatusSource;

    constructor(
        registry: DockRegistry = getDockRegistry(),
        statusSource: DockStatusSource = new DockStatusSource(),
    ) {
        this.registry = registry;
        this.statusSource = statusSource;
    }

    /** Undefined once detached: the widget may render one last frame after its footer data is gone. */
    collectStatus(): DockStatus | undefined {
        if (!this.ctx || !this.footerData) return undefined;
        return this.statusSource.collect(this.ctx, this.footerData);
    }

    observeMessage(event: DockMessageEvent, ctx: ExtensionContext): void {
        if (
            !this.ctx ||
            this.ctx.ui !== ctx.ui ||
            this.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
        )
            return;
        if (this.statusSource.observeMessage(event, ctx)) this.tui?.requestRender();
    }

    resetTokenSpeed(): void {
        this.statusSource.resetTokenSpeed();
        this.invalidate();
    }

    /** Nothing to draw before attachment, or when a style that shows statistics has no footer data yet. */
    footerInput(focused: boolean): DockFooterInput | undefined {
        if (!this.ctx) return undefined;
        const status = replacesFooter(this.layout.style) ? this.collectStatus() : undefined;
        if (replacesFooter(this.layout.style) && !status) return undefined;
        return {
            entries: this.items,
            status,
            selectedId: focused ? this.selectedId : undefined,
            mode: this.displayMode,
            layout: this.layout,
        };
    }

    attach(ctx: ExtensionContext): void {
        this.detach();
        if (ctx.mode !== "tui") return;
        this.ctx = ctx;
        if (replacesFooter(this.layout.style)) this.mountFooter();
        this.mountWidget();
        this.unsubscribeInput = ctx.ui.onTerminalInput((data) => {
            try {
                return this.handleEntryInput(data);
            } catch (error) {
                this.reportError(error);
                return { consume: true };
            }
        });
        try {
            this.releaseHost = this.registry.attachHost(ctx.ui, this);
            this.refresh();
        } catch (error) {
            this.detach();
            throw error;
        }
    }

    detach(): void {
        this.generation++;
        this.queuedGeneration = undefined;
        this.statusSource.resetTokenSpeed();
        this.unsubscribeInput?.();
        this.unsubscribeInput = undefined;
        this.leaveFocus();
        const ctx = this.ctx;
        this.ctx = undefined;
        ctx?.ui.setWidget(WIDGET_ID, undefined);
        // Restoring unconditionally would evict a footer another extension installed after ours.
        if (this.footerMounted) ctx?.ui.setFooter(undefined);
        this.footerData = undefined;
        this.releaseHost?.();
        this.releaseHost = undefined;
        this.tui = undefined;
        this.component = undefined;
        this.editor = undefined;
        this.items = [];
        this.selectedId = undefined;
        this.opening = false;
    }

    invalidate(): void {
        if (!this.ctx || this.queuedGeneration === this.generation) return;
        const generation = this.generation;
        this.queuedGeneration = generation;
        queueMicrotask(() => {
            if (this.queuedGeneration !== generation) return;
            this.queuedGeneration = undefined;
            if (generation !== this.generation || !this.ctx) return;
            try {
                this.refresh();
            } catch (error) {
                this.reportError(error);
            }
        });
    }

    /** A tree jump must not let an old panel continuation recapture the new branch's focus. */
    resetInteraction(): void {
        this.generation++;
        this.opening = false;
        this.leaveFocus();
        this.refresh();
    }

    releaseComponent(component: DockComponent): void {
        if (this.component !== component) return;
        this.leaveFocus();
        this.component = undefined;
    }

    /** An unrelated overlay may restore an empty dock after its final item disappeared. */
    onFocusRestored(component: DockComponent): void {
        if (this.items.length > 0) return;
        const generation = this.generation;
        queueMicrotask(() => {
            if (
                generation === this.generation &&
                this.component === component &&
                this.items.length === 0
            ) {
                this.leaveFocus();
            }
        });
    }

    /**
     * The dock draws the model, directory and usage rows itself, so Pi's own footer must render
     * nothing. The footer factory is also the only place Pi hands extensions its footer data.
     */
    private syncFooter(): void {
        if (replacesFooter(this.layout.style)) {
            this.mountFooter();
        } else if (this.footerMounted) {
            this.ctx!.ui.setFooter(undefined);
        }
    }

    private mountFooter(): void {
        this.ctx!.ui.setFooter((_tui, _theme, footerData) => {
            // Pi shares one provider for the whole app, so it outlives this footer being replaced.
            this.footerData = footerData;
            this.footerMounted = true;
            const unsubscribe = footerData.onBranchChange(() => this.tui?.requestRender());
            return {
                render: () => [],
                invalidate() {},
                dispose: () => {
                    unsubscribe();
                    this.footerMounted = false;
                },
            };
        });
    }

    private mountWidget(): void {
        const previous = this.component;
        this.ctx!.ui.setWidget(
            WIDGET_ID,
            (tui, theme) => {
                // Both concrete Pi renderers expose focus inspection; the shared TUI interface
                // omits that method even though it is public on their common base class.
                this.tui = tui as TuiMainScreen | TuiAltScreen;
                this.component = new DockComponent(this, theme);
                if (previous && this.tui.getFocusedComponent() === previous) {
                    this.tui.setFocus(this.component);
                }
                return this.component;
            },
            { placement: "belowEditor" },
        );
    }

    private synchronizeTui(): void {
        // Pi moves the same component tree between regular/fullscreen renderers and sets
        // the retired renderer's focus to null. Re-running our factory obtains the active
        // renderer without replacing the main editor or accessing private Pi state.
        if (this.ctx && this.tui && this.tui.getFocusedComponent() === null) this.mountWidget();
    }

    private refresh(): void {
        if (!this.ctx) return;
        this.synchronizeTui();
        const previousIndex = this.items.findIndex((entry) => entry.id === this.selectedId);
        this.items = this.registry
            .getContributions(this.ctx.ui)
            .filter(({ id }) => !this.hidden.has(id))
            .sort((a, b) => (this.order[a.id] ?? 0) - (this.order[b.id] ?? 0))
            .map(({ id, snapshot }) => ({ id, snapshot }));
        if (!this.items.some((entry) => entry.id === this.selectedId)) {
            this.selectedId =
                this.items[Math.max(0, Math.min(previousIndex, this.items.length - 1))]?.id;
        }
        if (this.items.length === 0) this.leaveFocus();
        this.tui?.requestRender();
    }

    private handleEntryInput(data: string): { consume: true } | undefined {
        if (isKeyRelease(data) || this.opening || !this.ctx || !this.component || !this.tui) return;
        const forced = matchesKey(data, "super+down");
        if (!forced && !matchesKey(data, "down")) return;
        this.synchronizeTui();
        if (this.tui.hasOverlay()) return;
        const focused = this.tui.getFocusedComponent();
        // CustomEditor is Pi's main-editor integration contract. An extension selector or
        // standalone editor must keep its own navigation even when the main text is empty.
        if (!(focused instanceof CustomEditor) || focused.isShowingAutocomplete()) return;
        if (!forced && this.ctx.ui.getEditorText().length !== 0) return;
        this.refresh();
        if (this.items.length === 0) return;
        this.editor = focused;
        this.tui.setFocus(this.component);
        this.tui.requestRender();
        return { consume: true };
    }

    handleFocusedInput(data: string): void {
        try {
            this.processFocusedInput(data);
        } catch (error) {
            this.reportError(error);
        }
    }

    private processFocusedInput(data: string): void {
        // A release must never be mistaken for "some other key": that would hand focus back.
        if (isKeyRelease(data)) return;
        this.synchronizeTui();
        if (!this.component?.focused || !this.tui || this.opening) return;
        this.refresh();
        if (this.items.length === 0) return;
        if (matchesKey(data, "left")) {
            this.moveSelection(-1);
        } else if (matchesKey(data, "right")) {
            this.moveSelection(1);
        } else if (matchesKey(data, "home")) {
            this.selectAt(0);
        } else if (matchesKey(data, "end")) {
            this.selectAt(this.items.length - 1);
        } else if (matchesKey(data, "enter")) {
            void this.openSelected();
        } else if (matchesKey(data, "escape") || matchesKey(data, "up")) {
            // Returning to the editor must consume Up instead of selecting its previous input.
            this.leaveFocus();
        } else if (!matchesKey(data, "down")) {
            // Typing, paste and app shortcuts return to the editor without losing the input.
            const editor = this.editor;
            this.leaveFocus();
            editor?.handleInput?.(data);
        }
    }

    /** Wraps around; the view scrolls only as far as needed to keep the selection visible. */
    private moveSelection(delta: number): void {
        const count = this.items.length;
        const index = this.items.findIndex((entry) => entry.id === this.selectedId);
        this.selectAt((index + delta + count) % count);
    }

    private selectAt(index: number): void {
        this.selectedId = this.items[index]?.id;
        this.tui?.requestRender();
    }

    private leaveFocus(): void {
        if (this.component?.focused && this.tui?.getFocusedComponent() === this.component) {
            this.tui.setFocus(this.editor ?? null);
            this.tui.requestRender();
        }
    }

    private async openSelected(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx || !this.tui || !this.selectedId) return;
        const contribution = this.registry
            .getContributions(ctx.ui)
            .find((entry) => entry.id === this.selectedId);
        if (!contribution) return;
        this.opening = true;
        const generation = this.generation;
        const ui = ctx.ui;
        // Open against the editor, so an overlay never records the dock as a stale preFocus.
        this.leaveFocus();
        try {
            await contribution.provider.activate();
        } catch (error) {
            ui.notify(
                `Lune dock failed to open ${contribution.id}: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        } finally {
            if (generation === this.generation && this.ctx === ctx) {
                this.opening = false;
                try {
                    this.refresh();
                } catch (error) {
                    this.reportError(error);
                    // eslint-disable-next-line no-unsafe-finally -- A failed refresh must not refocus a stale dock.
                    return;
                }
                if (this.items.length > 0 && this.component && !this.tui?.hasOverlay()) {
                    const focused = this.tui?.getFocusedComponent();
                    if (focused instanceof CustomEditor) this.editor = focused;
                    this.tui?.setFocus(this.component);
                    this.tui?.requestRender();
                }
            }
        }
    }

    private reportError(error: unknown): void {
        this.ctx?.ui.notify(
            `Lune dock failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
        );
    }
}
