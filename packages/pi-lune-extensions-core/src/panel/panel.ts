/**
 * Interactive Settings renderer, intentionally reachable only through /panel/tui.
 *
 * One interaction owns the frame, focus, section subscriptions, editors and previews.
 * It borrows registered sections/views and never owns their storage lifecycle.
 * Navigation edits scoped committed values; input/select modes stage candidates until
 * confirmation, while cycle choices commit immediately. Selection sources own discovery,
 * not persistence. Save failures and committed observer failures have different UI states.
 */
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    Input,
    SelectList,
    isKeyRelease,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type Focusable,
    type TUI,
} from "@earendil-works/pi-tui";
import { corePanel } from "../core/panel.ts";
import { isSettingsNotificationError } from "../settings/types.ts";
import type { SettingsScope } from "../settings/types.ts";
import { getSettingsPanelRegistry, type SettingsPanelRegistry } from "./host.ts";
import { SettingsChoiceEditor } from "./choice-editor.ts";
import { MaskedInput } from "./masked-input.ts";
import {
    settingsEditor,
    valueAtScope,
    type SettingsEditorComponent,
    type SettingsPanelField,
    type SettingsSection,
} from "./section.ts";

const SECRET_MASK = "••••••••";
const PROJECT_UNTRUSTED = "Project settings are disabled because this folder is not trusted.";

function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value) ?? String(value);
}

// Strings are raw text and numbers are parsed strictly; everything else is JSON. All are revalidated.
function parseValue(field: SettingsPanelField, text: string): unknown {
    const editor = settingsEditor(field);
    let value: unknown;
    if (editor === "text") value = text;
    else if (editor === "number") {
        const trimmed = text.trim();
        if (!trimmed) throw new TypeError(`Enter a number for ${field.label}`);
        value = Number(trimmed);
        if (!Number.isFinite(value)) throw new TypeError(`"${trimmed}" is not a number`);
    } else value = JSON.parse(text);
    if (!Value.Check(field.schema, value)) throw new TypeError(`Invalid value for ${field.label}`);
    return value;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Frame-level state machine: navigation -> text/number/JSON/secret input, choice editor
 * or custom editor -> navigation. The edited field is captured on entry because
 * conditional visibility may rebuild the list while an editor is open.
 * busy serializes accepted persistence operations; disposed prevents their completion
 * from refreshing a retired interaction. Dynamic membership follows stable ctx.ui,
 * not Settings IDs across runners. Child editors must not draw a second shared frame.
 */
class SettingsPanel implements Component, Focusable {
    private sections: readonly SettingsSection[] = [];
    private activeSection = 0;
    private list: SelectList | undefined;
    private scope: SettingsScope;
    private input: Input | MaskedInput | undefined;
    private choiceEditor?: SettingsChoiceEditor;
    private customEditor: SettingsEditorComponent | undefined;
    private editing: SettingsPanelField | undefined;
    // List rows that are group headings; navigation steps over them.
    private headings = new Set<string>();
    private visibleFields = 0;
    // Failures of visible() checks; the field stays listed so it cannot vanish silently.
    private visibilityErrors: string[] = [];
    private preview: (Component & { dispose?: () => void }) | undefined;
    private error = "";
    private busy = false;
    private disposed = false;
    private isFocused = false;
    private readonly sectionSubscriptions = new Map<SettingsSection, () => void>();
    private releaseRegistry: (() => void) | undefined;
    private readonly ctx: ExtensionContext;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly done: () => void;
    private readonly registry: SettingsPanelRegistry;

    constructor(
        ctx: ExtensionContext,
        tui: TUI,
        theme: Theme,
        done: () => void,
        registry: SettingsPanelRegistry,
        options: { section?: string; scope?: SettingsScope },
    ) {
        this.ctx = ctx;
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.registry = registry;
        this.scope = options.scope ?? "global";
        this.syncSections();
        if (options.section) {
            const index = this.sections.findIndex(({ id }) => id === options.section);
            if (index < 0) {
                this.dispose();
                throw new Error(`Unknown settings section "${options.section}"`);
            }
            this.activeSection = index;
            this.refresh();
        }
        // Subscribed last, so a failing initial binding cannot leave a subscription behind.
        this.releaseRegistry = registry.subscribe(ctx.ui, () => this.syncSections());
    }

    get focused(): boolean {
        return this.isFocused;
    }
    set focused(value: boolean) {
        this.isFocused = value;
        if (this.input) this.input.focused = value;
        if (this.choiceEditor) this.choiceEditor.focused = value;
        if (this.customEditor && "focused" in this.customEditor) this.customEditor.focused = value;
    }

    private get section(): SettingsSection | undefined {
        return this.sections[this.activeSection];
    }
    // An unavailable section has no trustworthy fields to list or edit.
    private get fields(): readonly SettingsPanelField[] {
        return this.section?.unavailable === undefined ? (this.section?.fields ?? []) : [];
    }
    private get field(): SettingsPanelField | undefined {
        const id = this.list?.getSelectedItem()?.value;
        return this.fields.find((field) => field.id === id);
    }
    private get projectDisabled(): boolean {
        // An unavailable section has no scopes because it has no view, not because of trust.
        return (
            this.scope === "project" &&
            !!this.section &&
            this.section.unavailable === undefined &&
            !this.section.scopes.includes("project")
        );
    }

    // Why this field cannot be written at the current scope, if it cannot.
    private scopeError(field: SettingsPanelField): string | undefined {
        if (this.projectDisabled) return PROJECT_UNTRUSTED;
        if (!field.scopes.includes(this.scope)) return `${field.label} can only be set globally`;
        return this.disabledReason(field);
    }

    // A failing check blocks editing and says why, rather than guessing the field is usable.
    private disabledReason(field: SettingsPanelField): string | undefined {
        try {
            return field.disabled?.(this.ctx, this.scope);
        } catch (error) {
            return `Could not check whether ${field.label} can be changed: ${message(error)}`;
        }
    }

    // Sections can register or retire while the panel is open; subscriptions follow that list.
    private syncSections(): void {
        const previous = this.section;
        this.sections = [...this.registry.getSections(this.ctx.ui)].sort((left, right) => {
            if (left.id === right.id) return 0;
            if (left.id === corePanel.id) return -1;
            if (right.id === corePanel.id) return 1;
            if (left.label !== right.label) return left.label < right.label ? -1 : 1;
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
        for (const [section, release] of this.sectionSubscriptions) {
            if (this.sections.includes(section)) continue;
            release();
            this.sectionSubscriptions.delete(section);
        }
        try {
            for (const section of this.sections) {
                if (!this.sectionSubscriptions.has(section)) {
                    this.sectionSubscriptions.set(
                        section,
                        section.subscribe(() => this.refresh()),
                    );
                }
            }
        } catch (error) {
            this.dispose();
            throw error;
        }
        // A successful retry replaces the section object, so identity falls back to its id.
        const index = this.sections.indexOf(previous!);
        this.activeSection = Math.max(
            0,
            index < 0 && previous ? this.sections.findIndex(({ id }) => id === previous.id) : index,
        );
        if (previous && previous !== this.section) {
            this.list = undefined;
            this.input = undefined;
            this.editing = undefined;
            this.choiceEditor?.dispose();
            this.choiceEditor = undefined;
            this.closeCustomEditor(false);
        }
        this.refresh();
    }

    // The list is rebuilt because values, visibility and registered sections change while it is open.
    private refresh(): void {
        if (this.disposed) return;
        const selected = this.list?.getSelectedItem()?.value;
        this.visibilityErrors = [];
        const fields = this.fields.filter((field) => {
            try {
                return field.visible?.(this.ctx, this.scope) ?? true;
            } catch (error) {
                this.visibilityErrors.push(
                    `Could not check whether to show ${field.label}: ${message(error)}`,
                );
                return true;
            }
        });
        this.visibleFields = fields.length;
        this.headings = new Set();
        const items: { value: string; label: string; description: string }[] = [];
        let group: string | undefined;
        let headingIds = 0;
        for (const field of fields) {
            if (field.group !== undefined && field.group !== group) {
                let heading: string;
                // Custom sections choose arbitrary field ids, so a heading id must avoid them all.
                do heading = `\0heading:${headingIds++}`;
                while (fields.some(({ id }) => id === heading));
                this.headings.add(heading);
                items.push({
                    value: heading,
                    label: this.theme.fg("muted", this.theme.bold(field.group)),
                    description: "",
                });
            }
            group = field.group;
            const value = valueAtScope(field.inspect(), this.scope);
            // The mask length is fixed so it cannot leak the secret's length.
            const label = field.secret
                ? typeof value === "string" && value
                    ? SECRET_MASK
                    : "(not set)"
                : (field.choices?.find((choice) => isDeepStrictEqual(choice.value, value))?.label ??
                  field.formatValue?.(value, this.ctx, this.scope) ??
                  formatValue(value));
            const globalOnly = !this.projectDisabled && !field.scopes.includes(this.scope);
            items.push({
                value: field.id,
                label: field.label,
                description: [label, globalOnly && "global only", this.disabledReason(field)]
                    .filter(Boolean)
                    .join(" · "),
            });
        }
        this.list = new SelectList(items, 8, {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("muted", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("dim", text),
        });
        const index = items.findIndex(({ value }) => value === selected);
        this.list.setSelectedIndex(
            index >= 0
                ? index
                : Math.max(
                      0,
                      items.findIndex(({ value }) => !this.headings.has(value)),
                  ),
        );
        this.list.onSelectionChange = () => {
            this.error = "";
            this.updatePreview();
        };
        this.list.onSelect = () => this.edit();
        this.list.onCancel = () => this.close();
        this.updatePreview();
        this.tui.requestRender();
    }

    // A failing preview must not close the panel; the error line replaces it.
    private updatePreview(): void {
        this.preview?.dispose?.();
        this.preview = undefined;
        const field = this.editing ?? this.field;
        if (!field?.preview) return;
        try {
            const choice = this.choiceEditor?.getSelectedChoice();
            const value = this.input
                ? parseValue(field, this.input.getValue())
                : choice
                  ? choice.value
                  : valueAtScope(field.inspect(), this.scope);
            this.preview = field.preview(value, this.theme, this.scope);
        } catch (error) {
            this.error = message(error);
        }
    }

    // Capture section/write scope at editor entry; candidate-range changes cannot retarget a save.
    private edit(): void {
        const field = this.field;
        if (!field) return;
        this.error = "";
        const blocked = this.scopeError(field);
        if (blocked) {
            this.error = blocked;
            return;
        }
        const section = this.section;
        const editor = settingsEditor(field);
        if (editor === "select") {
            const scope = this.scope;
            this.choiceEditor = new SettingsChoiceEditor(
                field,
                this.ctx,
                scope,
                this.theme,
                () => {
                    this.updatePreview();
                    this.tui.requestRender();
                },
                async (value, reload) => {
                    await this.commit(() => field.set(value, scope));
                    if (reload) await this.reloadSection(section, true);
                },
                () => {
                    this.choiceEditor?.dispose();
                    this.choiceEditor = undefined;
                    this.editing = undefined;
                    this.refresh();
                },
            );
            this.editing = field;
            this.choiceEditor.focused = this.focused;
            this.updatePreview();
            return;
        }
        if (editor === "custom") {
            this.openCustomEditor(field);
            return;
        }
        if (editor === "cycle" && field.choices?.length) {
            const current = valueAtScope(field.inspect(), this.scope);
            const index = field.choices.findIndex(({ value }) => isDeepStrictEqual(value, current));
            const choice = field.choices[(index + 1) % field.choices.length]!;
            if (choice.disabled) {
                this.error = choice.disabled;
                return;
            }
            void this.apply(() => this.commit(() => field.set(choice.value, this.scope)));
            return;
        }
        if (field.secret) {
            // Deliberately not seeded: the stored secret must never reach the screen.
            this.input = new MaskedInput((text) => this.theme.fg("dim", text));
        } else {
            const input = new Input();
            const value = valueAtScope(field.inspect(), this.scope);
            input.setValue(
                editor === "text" || editor === "number"
                    ? String(value)
                    : (JSON.stringify(value) ?? ""),
            );
            this.input = input;
        }
        this.editing = field;
        this.input.focused = this.focused;
        this.input.onEscape = () => this.cancelInput();
        this.input.onSubmit = () => this.save();
        this.updatePreview();
    }

    // Host callbacks are tied to this component instance so a closed editor cannot save.
    private openCustomEditor(field: SettingsPanelField): void {
        const scope = this.scope;
        let component: SettingsEditorComponent | undefined;
        const current = () => component !== undefined && this.customEditor === component;
        try {
            component = field.customEditor!({
                context: this.ctx,
                scope,
                theme: this.theme,
                value: Value.Clone(valueAtScope(field.inspect(), scope)),
                submit: (value) => {
                    if (current()) this.submitCustom(field, scope, value);
                },
                cancel: () => {
                    if (current()) this.closeCustomEditor();
                },
                requestRender: () => {
                    if (current()) this.tui.requestRender();
                },
            });
        } catch (error) {
            this.error = `Could not open the editor for ${field.label}: ${message(error)}`;
            return;
        }
        this.customEditor = component;
        this.editing = field;
        if ("focused" in component) component.focused = this.focused;
    }

    private submitCustom(field: SettingsPanelField, scope: SettingsScope, value: unknown): void {
        if (this.busy) {
            this.error = "A save is already in progress";
        } else if (!Value.Check(field.schema, value)) {
            this.error = `Invalid value for ${field.label}`;
        } else {
            const component = this.customEditor;
            void this.apply(async () => {
                await this.commit(() => field.set(Value.Clone(value), scope));
                if (this.customEditor === component) this.closeCustomEditor(false);
            });
        }
        this.tui.requestRender();
    }

    private closeCustomEditor(refresh = true): void {
        const component = this.customEditor;
        if (!component) return;
        this.customEditor = undefined;
        this.editing = undefined;
        try {
            component.dispose?.();
        } catch (error) {
            this.error = `Editor cleanup failed: ${message(error)}`;
        }
        if (refresh) this.refresh();
    }

    private cancelInput(): void {
        this.input = undefined;
        this.editing = undefined;
        this.error = "";
        this.updatePreview();
    }

    private save(reload = false): void {
        // An empty secret input means "keep current"; saving it would silently wipe the secret.
        if (this.input instanceof MaskedInput && !this.input.getValue()) {
            this.cancelInput();
            if (!reload) return;
        }
        const field = this.input ? this.editing : this.field;
        const editing = !!this.input;
        let value: unknown;
        try {
            if (field && editing) {
                value = parseValue(field, this.input!.getValue());
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            return;
        }
        const section = this.section;
        const scope = this.scope;
        void this.apply(async () => {
            if (field && editing) {
                await this.commit(() => field.set(value, scope));
                this.input = undefined;
                this.editing = undefined;
            }
            if (reload) await this.reloadSection(section, !!field && editing);
        });
    }

    // An observer error follows a real commit: close the candidate editor instead of retrying a save.
    private async commit(operation: () => Promise<void>): Promise<void> {
        try {
            await operation();
        } catch (error) {
            if (!isSettingsNotificationError(error)) throw error;
            this.error = `Saved; ${error.message}`;
        }
    }

    // Retrying replaces the failed section; its failure text stays on screen if it fails again.
    private retry(section: SettingsSection): void {
        void this.apply(async () => {
            try {
                await section.reload();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                    isSettingsNotificationError(error)
                        ? `Reloaded; ${message}`
                        : `Retry failed: ${message}`,
                    { cause: error },
                );
            }
        });
    }

    // Reload is separate from save; a failed reread must not imply that a successful write rolled back.
    private async reloadSection(
        section: SettingsSection | undefined,
        saved: boolean,
    ): Promise<void> {
        try {
            await section?.reload();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = isSettingsNotificationError(error)
                ? `Reloaded; ${message}`
                : `${saved ? "Saved, but reload failed" : "Reload failed"}: ${message}`;
            this.error = [this.error, status].filter(Boolean).join("; ");
        }
    }

    // Writes are awaited before refreshing, so a failed save keeps the real state visible.
    private async apply(operation: () => Promise<void>): Promise<void> {
        this.busy = true;
        this.error = "";
        this.tui.requestRender();
        try {
            await operation();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            if (!this.disposed) this.refresh();
        }
    }

    /**
     * Route input to exactly one mode; persistence suppresses further actions.
     * Ctrl+G changes persistence scope only in navigation. Inside a selector, Tab
     * changes its candidate range and Ctrl+R refreshes discovery rather than reset.
     * Left/Right switch sections only in navigation; open inputs and editors keep them.
     */
    handleInput(data: string): void {
        // Key-release events would otherwise repeat the action on terminals that report them.
        if (this.disposed || this.busy || isKeyRelease(data)) return;
        if (this.choiceEditor) {
            this.choiceEditor.handleInput(data);
            this.tui.requestRender();
            return;
        }
        if (this.customEditor) {
            // Escape stays with the panel so a faulty editor can never trap the user.
            if (matchesKey(data, "escape")) this.closeCustomEditor();
            else
                try {
                    this.customEditor.handleInput(data);
                } catch (error) {
                    this.error = message(error);
                }
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "ctrl+s")) {
            const section = this.section;
            if (section?.unavailable !== undefined) this.retry(section);
            else this.save(true);
        } else if (this.input) {
            const previous = this.input.getValue();
            this.input.handleInput(data);
            if (this.input && previous !== this.input.getValue()) {
                this.error = "";
                this.updatePreview();
            }
        } else if (
            (["tab", "shift+tab", "left", "right"] as const).some((key) => matchesKey(data, key))
        ) {
            if (this.sections.length) {
                const delta = matchesKey(data, "shift+tab") || matchesKey(data, "left") ? -1 : 1;
                this.activeSection =
                    (this.activeSection + delta + this.sections.length) % this.sections.length;
                this.list = undefined;
                this.error = "";
                this.refresh();
            }
        } else if (this.section?.unavailable !== undefined) {
            if (matchesKey(data, "escape")) this.close();
        } else if (matchesKey(data, "ctrl+g")) {
            this.scope = this.scope === "global" ? "project" : "global";
            this.error = "";
            this.refresh();
        } else if (matchesKey(data, "ctrl+r")) {
            const field = this.field;
            const blocked = field && this.scopeError(field);
            if (blocked) this.error = blocked;
            else if (field) void this.apply(() => this.commit(() => field.reset(this.scope)));
        } else if (matchesKey(data, "escape")) {
            this.close();
        } else if (data === " ") {
            this.edit();
        } else {
            this.list?.handleInput(data);
            // Repeating the same key keeps its direction, including the list's wrap-around.
            for (
                let step = 0;
                this.isHeading(this.list?.getSelectedItem()?.value) && step < this.headings.size;
                step++
            )
                this.list?.handleInput(data);
        }
        this.tui.requestRender();
    }

    private isHeading(value: string | undefined): boolean {
        return value !== undefined && this.headings.has(value);
    }

    /**
     * Own the common frame for navigation and nested selectors/previews.
     * Width is terminal-cell based, not string length; bound preview rows and reserve
     * description space so ordinary selection changes do not shift the surrounding UI.
     */
    render(width: number): string[] {
        width = Math.max(0, Math.floor(width));
        if (width === 0) return [];
        const rule = this.theme.fg("dim", "─".repeat(width));
        const tabs = this.sections
            .map((section, index) =>
                index === this.activeSection
                    ? this.theme.fg("accent", this.theme.bold(section.label))
                    : this.theme.fg(
                          section.unavailable === undefined ? "dim" : "error",
                          section.label,
                      ),
            )
            .join(this.theme.fg("dim", " / "));
        const field = this.editing ?? this.field;
        const inspection = field?.inspect();
        // Side-by-side preview needs room; below this width it is stacked under the list.
        const split = width >= 88 && !this.input && !!field?.preview;
        const bodyWidth = split ? Math.floor((width - 3) / 2) : width;
        let body = this.input
            ? this.input.render(bodyWidth)
            : this.customEditor
              ? this.renderCustomEditor(bodyWidth)
              : (this.choiceEditor?.renderBody(bodyWidth) ?? this.list?.render(bodyWidth) ?? []);
        if (!this.sections.length)
            body = [this.theme.fg("muted", "No extensions have registered settings.")];
        else if (this.section?.unavailable !== undefined)
            body = [
                this.theme.fg("error", "Settings could not be loaded:"),
                ...wrapTextWithAnsi(this.theme.fg("error", this.section.unavailable), bodyWidth),
                "",
                this.theme.fg("muted", "Fix the problem, then press Ctrl+S to retry."),
            ];
        else if (!this.section?.fields.length)
            body = [this.theme.fg("muted", "No settings are available in this section yet.")];
        else if (!this.visibleFields)
            body = [this.theme.fg("muted", "No settings in this section apply right now.")];
        const description = field?.description
            ? wrapTextWithAnsi(this.theme.fg("muted", field.description), bodyWidth).slice(0, 3)
            : [];
        // Reserve a description row so ordinary selection changes keep the frame stationary.
        body.push("", ...(description.length ? description : [""]));
        if (this.projectDisabled) body.push(this.theme.fg("warning", PROJECT_UNTRUSTED));
        if (this.scope === "global" && inspection?.source === "project") {
            body.push(
                this.theme.fg(
                    "warning",
                    "Project overrides global; preview shows global settings.",
                ),
            );
        }
        if (this.preview) {
            const leftWidth = bodyWidth;
            const rightWidth = split ? width - leftWidth - 3 : width;
            let lines: string[];
            try {
                lines = this.preview.render(rightWidth).flatMap((line) => line.split(/\r?\n/));
            } catch (error) {
                lines = [
                    this.theme.fg(
                        "error",
                        `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                ];
            }
            const preview = [
                this.theme.fg(
                    "accent",
                    this.input || this.choiceEditor ? "Preview · Unsaved" : "Preview",
                ),
                "",
                ...lines.slice(0, 8),
            ];
            if (split) {
                body = body.map((line) => truncateToWidth(line, leftWidth));
                body = Array.from({ length: Math.max(body.length, preview.length) }, (_, index) => {
                    const left = body[index] ?? "";
                    return (
                        left +
                        " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) +
                        this.theme.fg("dim", " │ ") +
                        (preview[index] ?? "")
                    );
                });
            } else body.push("", rule, ...preview);
        }
        const errors = [this.error, ...this.visibilityErrors].filter(Boolean);
        if (errors.length) body.push("", ...errors.map((text) => this.theme.fg("error", text)));
        return [
            rule,
            this.theme.fg(
                "accent",
                this.choiceEditor?.title ??
                    `${this.editing ? this.editing.label : "Lune settings"} · ${this.scope}${this.busy ? " · Saving / loading…" : ""}`,
            ),
            tabs,
            rule,
            ...body,
            rule,
            this.theme.fg(
                "dim",
                this.choiceEditor?.help ??
                    (this.customEditor
                        ? [this.customEditor.help, "Esc cancel"].filter(Boolean).join(" · ")
                        : this.input instanceof MaskedInput
                          ? "Enter save · empty Enter keeps current · Esc back"
                          : this.input
                            ? "Enter save · Ctrl+S save/reload · Esc back"
                            : this.section?.unavailable !== undefined
                              ? "Tab/←→ section · Ctrl+S retry · Esc close"
                              : "↑↓ select · Enter change · Tab/←→ section · Ctrl+G scope · Ctrl+S reload section · Ctrl+R reset · Esc close"),
            ),
            rule,
        ].map((line) => truncateToWidth(line, width));
    }

    // A throwing editor render must not take down the shared frame; Esc still closes it.
    private renderCustomEditor(width: number): string[] {
        try {
            return this.customEditor!.render(width);
        } catch (error) {
            return [this.theme.fg("error", `Editor failed to render: ${message(error)}`)];
        }
    }

    invalidate(): void {
        this.customEditor?.invalidate();
        this.choiceEditor?.invalidate();
        this.list?.invalidate();
        this.input?.invalidate();
        this.updatePreview();
        this.preview?.invalidate();
    }

    private close(): void {
        this.dispose();
        this.done();
    }

    /**
     * Retire only interaction-owned discovery, previews and subscriptions.
     * Accepted writes may still finish, but no refresh is requested afterward.
     * Registered sections and their borrowed Settings views remain owner-managed.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.choiceEditor?.dispose();
        this.closeCustomEditor(false);
        this.releaseRegistry?.();
        for (const release of this.sectionSubscriptions.values()) release();
        this.sectionSubscriptions.clear();
        this.preview?.dispose?.();
        this.preview = undefined;
    }
}

/**
 * Open one interactive Settings session over currently registered sections.
 *
 * Requires native TUI mode and the /panel/tui runtime peer. No Settings acquisition
 * occurs; consumers must register sections separately in this ctx.ui scope.
 * Closing releases interaction resources, not section registrations or Settings.
 * A previously accepted save may finish even when the interaction has closed.
 *
 * @param ctx Current native Pi context; do not reuse it after session retirement.
 * @param options Initial section ID and persistence scope (global by default).
 * @returns Resolves when the custom interaction finishes.
 * @throws For non-TUI mode, an unknown initial section or host/rendering failures.
 */
export async function openSettingsPanel(
    ctx: ExtensionContext,
    options: { section?: string; scope?: SettingsScope } = {},
): Promise<void> {
    if (ctx.mode !== "tui") throw new Error("Lune settings require interactive TUI mode");
    await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
            new SettingsPanel(ctx, tui, theme, done, getSettingsPanelRegistry(), options),
    );
}
