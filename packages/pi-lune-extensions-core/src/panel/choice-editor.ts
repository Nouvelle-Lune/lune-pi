/**
 * Selector interaction used inside the shared Settings frame.
 *
 * Owns search, candidate-range discovery, unsaved multi-selection and cancellation.
 * The parent supplies persistence/back callbacks and the fixed global/project scope;
 * it also owns previews/frame layout. Abort applies to discovery, not writes already
 * accepted by the parent. Hidden/unavailable saved selections survive list filtering.
 */
import { Value } from "typebox/value";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    Input,
    SelectList,
    fuzzyFilter,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";
import type { SettingsScope } from "../settings/types.ts";
import {
    valueAtScope,
    type SettingsChoice,
    type SettingsChoiceSource,
    type SettingsPanelField,
} from "./section.ts";

/**
 * Borrow a field/context for one editor lifetime; no Settings/backend ownership.
 * Replaced requests abort and lose publication rights; dispose prevents late renders.
 * @internal Consumers open /panel/tui rather than constructing this implementation.
 */
export class SettingsChoiceEditor implements Component, Focusable {
    private choices: readonly SettingsChoice[] = [];
    private visible: SettingsChoice[] = [];
    private selection: unknown[] = [];
    private list?: SelectList;
    private search = new Input();
    private candidateScope?: string;
    private controller?: AbortController;
    private disposed = false;
    private error = "";
    // Candidate loading only gates committing; saving must also drop local input.
    private loadingChoices = false;
    private saving = false;
    private isFocused = false;
    private readonly source: SettingsChoiceSource;
    private readonly field: SettingsPanelField;
    private readonly ctx: ExtensionContext;
    private readonly scope: SettingsScope;
    private readonly theme: Theme;
    private readonly renderAgain: () => void;
    private readonly save: (value: unknown, reload: boolean) => Promise<void>;
    private readonly back: () => void;

    constructor(
        field: SettingsPanelField,
        ctx: ExtensionContext,
        scope: SettingsScope,
        theme: Theme,
        renderAgain: () => void,
        save: (value: unknown, reload: boolean) => Promise<void>,
        back: () => void,
    ) {
        this.field = field;
        this.ctx = ctx;
        this.scope = scope;
        this.theme = theme;
        this.renderAgain = renderAgain;
        this.save = save;
        this.back = back;
        this.source = field.choiceSource ?? { load: () => field.choices ?? [] };
        const current = valueAtScope(field.inspect(), scope);
        this.selection = this.source.multiple && Array.isArray(current) ? [...current] : [];
        this.candidateScope = this.source.defaultScope?.(ctx) ?? this.source.scopes?.[0];
        void this.load();
    }

    get focused() {
        return this.isFocused;
    }
    set focused(value: boolean) {
        this.isFocused = value;
        this.search.focused = value;
    }
    /** Highlighted visible candidate for passive preview; not necessarily the committed value. */
    getSelectedChoice(): SettingsChoice | undefined {
        return this.visible[Number(this.list?.getSelectedItem()?.value)];
    }
    private context() {
        return (
            this.field.choiceContext?.(this.ctx, this.scope) ?? {
                context: this.ctx,
                scope: this.scope,
                values: undefined,
            }
        );
    }
    /**
     * Supersede one discovery generation while preserving prior usable choices on failure.
     * Cancellation alone is insufficient if a source ignores it; controller identity
     * also prevents an older request from publishing over a newer range/refresh.
     */
    private async load(refresh = false): Promise<void> {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.loadingChoices = true;
        this.error = "";
        this.renderAgain();
        try {
            if (refresh)
                await this.source.refresh?.({ ...this.context(), signal: controller.signal });
            controller.signal.throwIfAborted();
            const loaded = this.source.load({
                ...this.context(),
                candidateScope: this.candidateScope,
                signal: controller.signal,
            });
            // Synchronous sources retain their immediate keyboard behavior.
            const choices = loaded instanceof Promise ? await loaded : loaded;
            controller.signal.throwIfAborted();
            if (this.disposed || this.controller !== controller) return;
            const candidateSchema = this.source.multiple
                ? this.field.schema.items
                : this.field.schema;
            if (
                !candidateSchema ||
                choices.some((choice) => !Value.Check(candidateSchema, choice.value))
            )
                throw new TypeError(`Invalid dynamic choice for setting "${this.field.id}"`);
            this.choices = choices;
            this.filter(valueAtScope(this.field.inspect(), this.scope));
        } catch (error) {
            if (!controller.signal.aborted && !this.disposed)
                this.error = error instanceof Error ? error.message : String(error);
        } finally {
            if (this.controller === controller) {
                this.controller = undefined;
                this.loadingChoices = false;
                if (!this.disposed) this.renderAgain();
            }
        }
    }
    private filter(selected?: unknown): void {
        this.visible = fuzzyFilter(
            [...this.choices],
            this.search.getValue(),
            (choice) =>
                choice.searchText ??
                `${choice.label} ${choice.badge ?? ""} ${choice.description ?? ""}`,
        );
        const inline = this.source.rowLayout === "inline" || this.source.multiple;
        const current = valueAtScope(this.field.inspect(), this.scope);
        const checked = (choice: SettingsChoice) =>
            this.source.multiple
                ? this.selection.some((value) => isDeepStrictEqual(value, choice.value))
                : isDeepStrictEqual(choice.value, current);
        this.list = new SelectList(
            this.visible.map((choice, index) => ({
                value: String(index),
                label: inline
                    ? `${checked(choice) ? "✓ " : "  "}${choice.label}${choice.badge ? ` ${this.theme.fg("muted", `[${choice.badge}]`)}` : ""}`
                    : choice.label,
                description: inline ? undefined : (choice.disabled ?? choice.description),
            })),
            8,
            {
                selectedPrefix: (text) => this.theme.fg("accent", text),
                selectedText: (text) => this.theme.fg("accent", text),
                description: (text) => this.theme.fg("muted", text),
                scrollInfo: (text) => this.theme.fg("dim", text),
                noMatch: (text) => this.theme.fg("dim", text),
            },
        );
        this.list.setSelectedIndex(
            Math.max(
                0,
                this.visible.findIndex((choice) => isDeepStrictEqual(choice.value, selected)),
            ),
        );
        this.list.onSelectionChange = this.renderAgain;
        this.list.onSelect = () => {
            void this.submit();
        };
    }
    // Keep the full selection outside visible results so search/range changes cannot erase saved values.
    private toggle(): void {
        const choice = this.getSelectedChoice();
        if (!choice) return;
        if (choice.disabled) {
            this.error = choice.disabled;
            return;
        }
        const index = this.selection.findIndex((value) => isDeepStrictEqual(value, choice.value));
        if (index < 0) this.selection.push(choice.value);
        else this.selection.splice(index, 1);
        this.error = "";
        this.filter(choice.value);
    }
    // Validate the whole candidate (array for multiple) before persistence; do not save while discovering.
    private async submit(reload = false): Promise<void> {
        const choice = this.getSelectedChoice();
        if (this.loadingChoices || this.saving || (!this.source.multiple && !choice)) return;
        if (!this.source.multiple && choice?.disabled) {
            this.error = choice.disabled;
            return;
        }
        const value = this.source.multiple ? [...this.selection] : choice!.value;
        if (!Value.Check(this.field.schema, value)) {
            this.error = `Invalid value for ${this.field.label}`;
            return;
        }
        this.saving = true;
        this.renderAgain();
        try {
            await this.save(value, reload);
            if (!this.disposed) this.back();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.saving = false;
            if (!this.disposed) this.renderAgain();
        }
    }
    private get busy(): boolean {
        return this.loadingChoices || this.saving;
    }
    handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.back();
            return;
        }
        if (this.disposed || this.saving) return;
        if (matchesKey(data, "ctrl+s")) {
            void this.submit(true);
        } else if (matchesKey(data, "tab")) {
            const scopes = this.source.scopes;
            if (scopes?.length) {
                this.candidateScope =
                    scopes[(scopes.indexOf(this.candidateScope!) + 1) % scopes.length];
                void this.load();
            }
        } else if (matchesKey(data, "ctrl+r")) {
            if (this.source.refresh) void this.load(true);
        } else if (this.source.multiple && data === " ") this.toggle();
        else if (matchesKey(data, "enter")) {
            void this.submit();
        } else if (
            (["up", "down", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))
        )
            this.list?.handleInput(data);
        else {
            this.search.handleInput(data);
            this.filter();
            this.error = "";
        }
        this.renderAgain();
    }
    get title(): string {
        return `${this.field.label} · ${this.scope}${this.candidateScope ? ` · ${this.candidateScope}` : ""}${this.busy ? " · Saving / loading…" : ""}`;
    }
    get help(): string {
        return `↑↓ select · Type to search${this.source.multiple ? " · Space toggle" : ""} · Enter save · Ctrl+S save/reload · Esc back${this.source.scopes?.length ? " · Tab scope" : ""}${this.source.refresh ? " · Ctrl+R refresh" : ""}`;
    }
    // The panel owns the surrounding frame when it composes a selector with a preview.
    renderBody(width: number): string[] {
        const selected = this.getSelectedChoice();
        const details =
            this.source.rowLayout === "inline" || this.source.multiple
                ? [selected?.description, selected?.disabled].filter(
                      (text): text is string => !!text,
                  )
                : [];
        return [
            ...this.search.render(width),
            ...(!this.busy && !this.error && !this.choices.length && this.source.emptyMessage
                ? [this.theme.fg("muted", this.source.emptyMessage)]
                : []),
            ...(this.list?.render(width) ?? []),
            // Inline identities move details below the list; keep that slot when absent.
            ...(this.source.rowLayout === "inline" || this.source.multiple
                ? [
                      "",
                      ...(details.length
                          ? details.flatMap((text) =>
                                wrapTextWithAnsi(this.theme.fg("muted", text), width).slice(0, 3),
                            )
                          : [""]),
                  ]
                : []),
            ...(this.error ? [this.theme.fg("error", this.error)] : []),
        ].map((line) => truncateToWidth(line, width));
    }
    render(width: number): string[] {
        width = Math.max(0, Math.floor(width));
        if (width === 0) return [];
        const rule = this.theme.fg("dim", "─".repeat(width));
        const description = this.field.description
            ? wrapTextWithAnsi(this.theme.fg("muted", this.field.description), width).slice(0, 3)
            : [];
        return [
            rule,
            this.theme.fg("accent", this.title),
            rule,
            ...this.renderBody(width),
            "",
            ...(description.length ? description : [""]),
            rule,
            this.theme.fg("dim", this.help),
            rule,
        ].map((line) => truncateToWidth(line, width));
    }
    invalidate(): void {
        this.search.invalidate();
        this.list?.invalidate();
    }
    /** Abort discovery and reject late UI publication; persistence remains parent-owned. */
    dispose(): void {
        this.disposed = true;
        this.controller?.abort();
    }
}
