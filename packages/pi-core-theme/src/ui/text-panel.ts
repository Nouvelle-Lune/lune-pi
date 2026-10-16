import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";

export interface TextPanelItem {
    label: string;
    content: string;
    detail?: string;
    badge?: string;
    color?: Parameters<Theme["fg"]>[0];
    render?: (content: string, width: number, theme: Theme) => string[];
}

export interface TextPanelOptions {
    title: string;
    items: readonly TextPanelItem[];
    subtitle?: string;
    header?: (width: number, theme: Theme) => readonly string[];
    navigationTitle?: string;
    maxHeight?: number;
    theme: () => Theme;
    rows: () => number;
    repaint: () => void;
    close: () => void;
    copy: (content: string) => Promise<void>;
    notify: ExtensionContext["ui"]["notify"];
}

interface Document {
    content: string;
    lines: string[];
    wrapped?: { width: number; colors: unknown; rows: string[] };
}

/** Output and context share wrapped content; categorized panels route input by pane. */
export class TextPanel implements Component {
    private readonly options: TextPanelOptions;
    private readonly documents = new Map<number, Document>();
    private selected = 0;
    private top = 0;
    private pageSize = 1;
    private bodyWidth = 1;
    private bodyStart = 3;
    private sidebar = 0;
    private navigationTop = 0;
    private laidOut = false;
    private cached?: {
        width: number;
        height: number;
        selected: number;
        top: number;
        colors: unknown;
        lines: string[];
    };

    constructor(options: TextPanelOptions) {
        this.options = options;
    }

    private document(): Document {
        let document = this.documents.get(this.selected);
        if (!document) {
            const content = sanitizeToolResultText(
                this.options.items[this.selected]!.content,
            ).replace(/\t/g, "    ");
            const lines = content.split("\n");
            document = { content, lines };
            this.documents.set(this.selected, document);
        }
        return document;
    }

    invalidate() {
        this.cached = undefined;
    }

    private contentRows(): string[] {
        const document = this.document();
        const item = this.options.items[this.selected]!;
        const theme = this.options.theme();
        // As in Shell Inspector, wrapping is cached by pane width rather than repeated per wheel tick.
        if (
            document.wrapped?.width !== this.bodyWidth ||
            (item.render && document.wrapped.colors !== theme.colors)
        ) {
            document.wrapped = {
                width: this.bodyWidth,
                colors: theme.colors,
                rows: item.render
                    ? item.render(document.content, this.bodyWidth, theme)
                    : document.lines.flatMap((line) => wrapTextWithAnsi(line, this.bodyWidth)),
            };
        }
        return document.wrapped.rows;
    }

    private select(index: number) {
        const next = Math.max(0, Math.min(this.options.items.length - 1, index));
        if (next === this.selected) return;
        this.selected = next;
        this.top = 0;
        this.options.repaint();
    }

    private scroll(vertical: number) {
        this.top = Math.max(
            0,
            Math.min(this.contentRows().length - this.pageSize, this.top + vertical),
        );
        this.options.repaint();
    }

    private copy() {
        void this.options.copy(this.document().content).then(
            () =>
                this.options.notify(
                    this.options.items.length > 1 ? "Copied category" : "Copied full output",
                    "info",
                ),
            (error) => this.options.notify(String(error), "error"),
        );
    }

    handleInput(data: string) {
        const categories = this.options.items.length > 1;
        if (matchesKey(data, Key.escape)) this.options.close();
        else if (matchesKey(data, Key.shift("down"))) this.scroll(1);
        else if (matchesKey(data, Key.shift("up"))) this.scroll(-1);
        else if (matchesKey(data, Key.down)) {
            if (categories) this.select(this.selected + 1);
            else this.scroll(1);
        } else if (matchesKey(data, Key.up)) {
            if (categories) this.select(this.selected - 1);
            else this.scroll(-1);
        } else if (matchesKey(data, Key.pageDown)) this.scroll(this.pageSize);
        else if (matchesKey(data, Key.pageUp)) this.scroll(-this.pageSize);
        else if (matchesKey(data, Key.home)) this.scroll(-this.contentRows().length);
        else if (matchesKey(data, Key.end)) this.scroll(this.contentRows().length);
        else if (data === "c" || matchesKey(data, Key.ctrl("c"))) this.copy();
    }

    handleMouse(event: TuiMouseEvent) {
        if (!this.laidOut) return undefined;
        if (event.type === "wheel") {
            if (this.sidebar && event.x < this.sidebar + 4)
                this.select(this.selected + (event.wheelDelta ?? 0));
            else this.scroll(event.wheelDelta ?? 0);
            // Claim both panes so wheel events never reach the transcript behind the overlay.
            return { handled: true };
        }
        if (
            event.type === "press" &&
            event.button === "left" &&
            this.sidebar &&
            event.x >= 2 &&
            event.x < 2 + this.sidebar &&
            event.y >= this.bodyStart &&
            event.y < this.bodyStart + this.pageSize
        ) {
            const index = this.navigationTop + event.y - this.bodyStart;
            if (index < this.options.items.length) {
                this.select(index);
                return { handled: true };
            }
        }
        // Leave output presses and drags to Pi's native text selection, like Shell Inspector.
        return undefined;
    }

    render(width: number): string[] {
        const { items, subtitle, navigationTitle } = this.options;
        const categories = items.length > 1;
        const inner = Math.max(0, width - 4);
        const theme = this.options.theme();
        const customHeader = this.options.header?.(inner, theme);
        this.sidebar = categories ? Math.min(28, Math.floor(inner * 0.3)) : 0;
        const extraHeaders = customHeader ? customHeader.length - 1 : Number(!!subtitle);
        const paneHeader = !!navigationTitle && !!this.sidebar;
        const height = Math.max(
            7 + extraHeaders + Number(paneHeader),
            Math.min(this.options.maxHeight ?? 40, this.options.rows() - 4),
        );
        this.bodyStart = 3 + extraHeaders + Number(paneHeader);
        this.pageSize = Math.max(1, height - 6 - extraHeaders - Number(paneHeader));
        const rightWidth = Math.max(1, inner - (this.sidebar ? this.sidebar + 2 : 0));
        this.bodyWidth = Math.max(1, rightWidth - (paneHeader ? 2 : 0));
        this.navigationTop = Math.max(
            0,
            Math.min(this.selected - Math.floor(this.pageSize / 2), items.length - this.pageSize),
        );
        this.laidOut = true;
        const contentRows = this.contentRows();
        this.top = Math.min(this.top, Math.max(0, contentRows.length - this.pageSize));
        const cached = this.cached;
        if (
            cached &&
            cached.width === width &&
            cached.height === height &&
            cached.selected === this.selected &&
            cached.top === this.top &&
            cached.colors === theme.colors
        )
            return cached.lines;
        const border = (text: string) => theme.fg("borderMuted", text);
        const pad = (text: string, available: number) => {
            const clipped = truncateToWidth(text, available, "");
            return clipped + " ".repeat(Math.max(0, available - visibleWidth(clipped)));
        };
        const row = (text: string) => border("│ ") + pad(text, inner) + border(" │");
        const item = items[this.selected]!;
        const title = truncateToWidth(
            theme.bold(theme.fg("accent", this.options.title)),
            inner,
            "…",
        );
        const status = truncateToWidth(
            theme.fg(
                "dim",
                `${this.document().lines.length} lines · ${this.top + 1}–${Math.min(contentRows.length, this.top + this.pageSize)} / ${contentRows.length} rows`,
            ),
            Math.max(0, inner - visibleWidth(title) - 1),
            "…",
        );
        const separator = (joint: "┬" | "┴") =>
            this.sidebar
                ? border(
                      `├${"─".repeat(this.sidebar + 1)}${joint}${"─".repeat(Math.max(0, width - this.sidebar - 4))}┤`,
                  )
                : border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
        const headers: string[] = [];
        if (subtitle)
            headers.push(
                row(theme.fg("muted", `${subtitle}${item.detail ? ` · ${item.detail}` : ""}`)),
            );
        const pair = (left: string, right: string, available: number) => {
            const end = truncateToWidth(
                right,
                Math.max(0, available - visibleWidth(left) - 1),
                "…",
            );
            return pad(left, Math.max(0, available - visibleWidth(end))) + end;
        };
        const contentHeading = paneHeader
            ? row(
                  pad(theme.fg("dim", navigationTitle!), this.sidebar) +
                      border("│ ") +
                      pair(
                          theme.bold(theme.fg("text", item.label)),
                          theme.fg(
                              "dim",
                              `${item.badge ? `${item.badge} est. · ` : ""}${this.top + 1}–${Math.min(contentRows.length, this.top + this.pageSize)} / ${contentRows.length}`,
                          ),
                          rightWidth,
                      ),
              )
            : undefined;
        const thumbSize = Math.max(
            1,
            Math.floor((this.pageSize * this.pageSize) / contentRows.length),
        );
        const thumbTop =
            contentRows.length > this.pageSize
                ? Math.round(
                      (this.top / (contentRows.length - this.pageSize)) *
                          (this.pageSize - thumbSize),
                  )
                : 0;
        const body = Array.from({ length: this.pageSize }, (_, index) => {
            let text = theme.fg("toolOutput", contentRows[this.top + index] ?? "");
            if (paneHeader) {
                const scrollable = contentRows.length > this.pageSize;
                const thumb = index >= thumbTop && index < thumbTop + thumbSize;
                text =
                    pad(text, this.bodyWidth) +
                    " " +
                    (scrollable
                        ? theme.fg(thumb ? "scrollbarThumb" : "scrollbarTrack", thumb ? "┃" : "│")
                        : " ");
            }
            if (!this.sidebar) return row(text);
            const navigationIndex = this.navigationTop + index;
            const entry = items[navigationIndex];
            const selected = navigationIndex === this.selected;
            const color = entry?.color ?? "accent";
            const prefix = theme.fg(selected ? "accent" : "dim", selected ? "› " : "  ");
            const mark = entry?.color ? theme.fg(color, "● ") : "";
            const label = entry
                ? prefix +
                  mark +
                  (selected
                      ? theme.bold(theme.fg("text", entry.label))
                      : theme.fg("muted", entry.label))
                : "";
            let navigation =
                entry?.badge && this.sidebar >= 22
                    ? pair(label, theme.fg(selected ? color : "dim", entry.badge), this.sidebar)
                    : pad(label, this.sidebar);
            if (selected && navigationTitle) navigation = theme.bg("selectedBg", navigation);
            return row(navigation + border("│ ") + text);
        });
        const hints = categories
            ? inner >= 90
                ? "↑↓ categories · wheel per pane · Shift+↑↓ / PgUp/PgDn scroll · Home/End · c copy · Esc close"
                : inner >= 60
                  ? "↑↓ categories · wheel/⇧↑↓ scroll · PgUp/Dn · c copy · Esc close"
                  : inner >= 48
                    ? "↑↓ categories · wheel scroll · c copy · Esc close"
                    : inner >= 36
                      ? "↑↓ select · wheel scroll · Esc close"
                      : "↑↓ · c · Esc"
            : inner >= 74
              ? "Full output · ↑↓ / wheel · PgUp/PgDn · Home/End · c to copy · Esc to close"
              : inner >= 40
                ? "↑↓/wheel · PgUp/Dn · c copy · Esc close"
                : inner >= 28
                  ? "↑↓/wheel · c copy · Esc close"
                  : "↑↓ · c · Esc";
        const lines = [
            border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
            ...(customHeader
                ? customHeader.map((line) => row(line))
                : [
                      row(
                          title +
                              " ".repeat(
                                  Math.max(0, inner - visibleWidth(title) - visibleWidth(status)),
                              ) +
                              status,
                      ),
                      ...headers,
                  ]),
            separator("┬"),
            ...(contentHeading ? [contentHeading] : []),
            ...body,
            separator("┴"),
            row(theme.fg("dim", hints)),
            border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
        ].map((line) => truncateToWidth(line, width, ""));
        this.cached = {
            width,
            height,
            selected: this.selected,
            top: this.top,
            colors: theme.colors,
            lines,
        };
        return lines;
    }
}
