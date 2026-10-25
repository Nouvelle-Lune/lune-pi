import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { reportColor, stateColor } from "../notify/notification-box.ts";
import { displayLine, fitRanked, type RankedPart } from "../render/text.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { Run } from "../run/run.ts";
import { detailRows } from "./details.ts";
import {
    assembleFrame,
    BODY_TOP,
    cell,
    listWindowStart,
    paintScrollbar,
    paneGeometry,
    type PaneGeometry,
} from "./layout.ts";
import { TranscriptRenderer } from "./transcript.ts";
import { Viewport } from "./viewport.ts";

const REFRESH_INTERVAL_MS = 1000;
const NOTICE_MS = 2500;
const ERROR_NOTICE_MS = 6000;

export interface InspectorOptions {
    ctx: ExtensionContext;
    manager: RunManager;
    /** The user saw the run's outcome; the Dock stops marking it. */
    onSeen: (run: Run) => void;
}

export async function openSubagentInspector(options: InspectorOptions): Promise<void> {
    await options.ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) =>
            new SubagentInspector(
                options,
                () => tui.requestRender(),
                () => done(),
                () => tui.terminal.rows,
            ),
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: "90%",
                minWidth: 72,
                maxHeight: "85%",
                margin: 1,
            },
        },
    );
}

interface FrameLayout {
    geometry: PaneGeometry;
    listStart: number;
}

/**
 * The `/agents` panel: runs on the left, the selected run's live transcript on the right.
 *
 * Runs of the current branch come first; runs of other branches follow, dimmed, so their reports
 * can be copied over. Every write goes through the manager, which enforces read-only runs.
 */
export class SubagentInspector implements Component {
    private readonly ctx: ExtensionContext;
    private readonly manager: RunManager;
    private readonly onSeen: (run: Run) => void;
    private readonly requestRender: () => void;
    private readonly close: () => void;
    private readonly terminalRows: () => number;
    private readonly theme: Theme;
    private readonly transcripts: TranscriptRenderer;
    private readonly viewport = new Viewport();

    private selectedId: string | undefined;
    private details = false;
    private chat: Input | undefined;
    private notice: { text: string; color: ThemeColor } | undefined;
    private noticeTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private unsubscribe: (() => void) | undefined;
    private layout: FrameLayout | undefined;
    private disposed = false;

    constructor(
        options: InspectorOptions,
        requestRender: () => void,
        close: () => void,
        terminalRows: () => number,
    ) {
        this.ctx = options.ctx;
        this.manager = options.manager;
        this.onSeen = options.onSeen;
        this.requestRender = requestRender;
        this.close = close;
        this.terminalRows = terminalRows;
        this.theme = options.ctx.ui.theme;
        this.transcripts = new TranscriptRenderer(this.theme);
        this.selectedId = this.entries()[0]?.run.id;
        // The list shows states only, so another run's streamed tokens change nothing on screen.
        this.unsubscribe = this.manager.subscribe((change, run) => {
            if (change === "state" || run?.id === this.selectedId) {
                this.requestRender();
            }
        });
    }

    handleInput(data: string): void {
        if (this.chat) {
            if (matchesKey(data, Key.escape)) {
                this.chat = undefined;
                this.requestRender();
                return;
            }

            this.chat.handleInput(data);
            this.requestRender();
            return;
        }

        if (matchesKey(data, Key.escape)) {
            this.dispose();
            this.close();
            return;
        }

        const entry = this.selected();

        if (matchesKey(data, Key.shift("up")) || data === "K") {
            this.scroll(-1);
        } else if (matchesKey(data, Key.shift("down")) || data === "J") {
            this.scroll(1);
        } else if (matchesKey(data, Key.up) || data === "k") {
            this.moveSelection(-1);
        } else if (matchesKey(data, Key.down) || data === "j") {
            this.moveSelection(1);
        } else if (matchesKey(data, Key.home)) {
            this.viewport.jumpToOldest();
            this.requestRender();
        } else if (matchesKey(data, Key.end)) {
            this.viewport.follow();
            this.requestRender();
        } else if (matchesKey(data, Key.enter) && entry) {
            this.startChat(entry);
        } else if (data === "d" && entry) {
            this.details = !this.details;
            this.viewport.follow();
            this.requestRender();
        } else if (data === "x" && entry) {
            this.stop(entry.run);
        } else if (data === "c" && entry) {
            this.copy(entry);
        }
    }

    /** Fullscreen mode routes the mouse here; every action also has a key. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const layout = this.layout;

        if (!layout) {
            return undefined;
        }

        const { bodyHeight, rightStart } = layout.geometry;
        const row = event.y - BODY_TOP;

        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;

            if (event.x >= rightStart) {
                this.scroll(delta);
            } else {
                this.moveSelection(delta);
            }

            return { handled: true };
        }

        // Presses on the transcript stay with the TUI's text selection, which copies text out.
        if (
            row < 0 ||
            row >= bodyHeight ||
            event.x >= rightStart ||
            event.type !== "press" ||
            event.button !== "left" ||
            event.x < 1
        ) {
            return undefined;
        }

        const entry = this.entries()[layout.listStart + row];

        if (!entry) {
            return undefined;
        }

        this.select(entry.run.id);

        return { handled: true };
    }

    render(width: number): string[] {
        const entries = this.entries();
        let index = entries.findIndex((entry) => entry.run.id === this.selectedId);

        if (index === -1 && entries.length > 0) {
            index = 0;
            this.selectedId = entries[0]!.run.id;
        }

        const selected = entries[index];

        this.syncRefreshTimer(selected?.run);

        if (selected) {
            this.onSeen(selected.run);
        }

        const geometry = paneGeometry(width, this.terminalRows());
        const { bodyHeight, leftWidth, rightWidth } = geometry;
        const listStart = listWindowStart(Math.max(0, index), entries.length, bodyHeight);
        const left = this.listRows(entries, listStart, index, leftWidth, bodyHeight);
        let right: string[];

        if (selected) {
            const contentWidth = Math.max(1, rightWidth - 2);
            const transcript = this.details
                ? detailRows(selected.run, this.theme, contentWidth)
                : this.transcriptOf(selected.run, contentWidth);
            const modelRows = this.modelRows(selected.run, contentWidth);
            const capacity = Math.max(1, bodyHeight - 1 - modelRows.length);
            const view = this.viewport.window(transcript.length, capacity);
            const rows = transcript
                .slice(view.start, view.start + capacity)
                .map((row) => cell(row, rightWidth));

            while (rows.length < capacity) {
                rows.push(" ".repeat(rightWidth));
            }

            right = [
                cell(this.title(selected, view.newestHidden, contentWidth), rightWidth),
                ...modelRows.map((row) => cell(row, rightWidth)),
                ...paintScrollbar(this.theme, rows, view.start, capacity, transcript.length),
            ];
        } else {
            right = [cell(this.theme.fg("muted", "No subagent runs in this session."), rightWidth)];
        }

        this.layout = { geometry, listStart };

        return assembleFrame(this.theme, geometry, {
            header: cell(this.header(entries), geometry.innerWidth),
            left,
            right,
            footer: this.footer(geometry.innerWidth, selected),
        });
    }

    invalidate(): void {
        this.transcripts.clear();
    }

    /** A run file that cannot be read shows its error in place of the transcript. */
    private transcriptOf(run: Run, width: number): readonly string[] {
        try {
            return this.transcripts.render(run, width);
        } catch (error) {
            const text = `The run transcript cannot be read: ${error instanceof Error ? error.message : String(error)}`;

            return wrapTextWithAnsi(displayLine(text), width).map((row) =>
                this.theme.fg("error", row),
            );
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        clearInterval(this.refreshTimer);
        clearTimeout(this.noticeTimer);
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private entries(): Entry[] {
        const { here, elsewhere } = this.manager.runsByBranch();

        return [
            ...here.map((run) => ({ run, elsewhere: false })),
            ...elsewhere.map((run) => ({ run, elsewhere: true })),
        ];
    }

    private selected(): Entry | undefined {
        return this.entries().find((entry) => entry.run.id === this.selectedId);
    }

    private listRows(
        entries: readonly Entry[],
        start: number,
        selected: number,
        width: number,
        height: number,
    ): string[] {
        const rows: string[] = [];

        for (let index = start; index < Math.min(entries.length, start + height); index++) {
            const { run, elsewhere } = entries[index]!;
            const report =
                run.lastTurn && run.state !== "running"
                    ? (run.lastTurn.report?.status ?? "unreported")
                    : undefined;
            const marker = elsewhere ? "↪" : run.state === "running" ? "◐" : "●";
            const text =
                this.theme.fg(elsewhere ? "dim" : stateColor(run.state), marker) +
                " " +
                this.theme.fg(elsewhere ? "muted" : "text", run.name) +
                " " +
                this.theme.fg(stateColor(run.state), run.state) +
                (report ? ` ${this.theme.fg(reportColor(report), report)}` : "") +
                (run.readOnly ? this.theme.fg("dim", " read-only") : "");
            rows.push(cell(text, width));
        }

        // The bar replaces each row's last padding column, so it goes on before the selection
        // background wraps the row in escape sequences.
        return paintScrollbar(this.theme, rows, start, height, entries.length).map((row, offset) =>
            start + offset === selected ? this.theme.bg("selectedBg", row) : row,
        );
    }

    private header(entries: readonly Entry[]): string {
        const running = entries.filter((entry) => entry.run.state === "running").length;
        const here = entries.filter((entry) => !entry.elsewhere).length;
        const elsewhere = entries.length - here;
        const counts = [
            `${here} on this branch`,
            elsewhere > 0 ? `${elsewhere} on other branches` : undefined,
            running > 0 ? this.theme.fg("warning", `${running} running`) : undefined,
        ]
            .filter((part) => part !== undefined)
            .join(this.theme.fg("dim", " · "));

        return `${this.theme.bold("Subagents")}  ${this.theme.fg("muted", counts)}`;
    }

    /** The run's name and every label that fits; a narrow pane leaves out the least useful first. */
    private title(entry: Entry, newestHidden: number, width: number): string {
        const { run } = entry;
        const report = run.lastTurn?.report?.status;
        const name = this.theme.bold(run.name);
        const parts: Array<RankedPart | undefined> = [
            // A run without a readable snapshot is already named by its ID.
            run.name !== run.id ? { text: this.theme.fg("dim", run.id), rank: 1 } : undefined,
            { text: this.theme.fg(stateColor(run.state), run.state), rank: 5 },
            report && run.state !== "running"
                ? { text: this.theme.fg(reportColor(report), report), rank: 4 }
                : undefined,
            entry.elsewhere ? { text: this.theme.fg("muted", "other branch"), rank: 3 } : undefined,
            this.details ? { text: this.theme.fg("accent", "details"), rank: 2 } : undefined,
            newestHidden > 0
                ? { text: this.theme.fg("accent", `↓ ${newestHidden} newer · End`), rank: 6 }
                : undefined,
        ];

        return (
            fitRanked(
                parts.filter((part) => part !== undefined),
                width,
                (texts) => [name, ...texts].join(this.theme.fg("dim", " · ")),
            ) ?? name
        );
    }

    /**
     * `Model provider/id · high`, from the live session when there is one. A narrow pane drops the
     * `Model` label, then gives the model its own rows; nothing is cut.
     */
    private modelRows(run: Run, width: number): string[] {
        const model = run.model;
        const thinking = run.thinkingLevel;

        // A run whose file cannot be read has neither.
        if (model === undefined || thinking === undefined) {
            return [];
        }

        const label = `${this.theme.fg("muted", "Model")} `;
        const separator = this.theme.fg("dim", " · ");
        const row = [
            `${label}${model}${separator}${thinking}`,
            `${model}${separator}${thinking}`,
        ].find((candidate) => visibleWidth(candidate) <= width);

        return row !== undefined ? [row] : [...wrapTextWithAnsi(model, width), thinking];
    }

    private footer(width: number, entry: Entry | undefined): string {
        if (this.chat) {
            const prompt = this.theme.fg("accent", `To ${entry?.run.name ?? "run"}: `);
            const input = this.chat.render(Math.max(1, width - 2 - visibleWidth(prompt)))[0] ?? "";

            return ` ${prompt}${input}`;
        }

        if (this.notice) {
            return cell(this.theme.fg(this.notice.color, this.notice.text), width);
        }

        const hints = [
            "↑↓ run",
            "⇧↑↓ scroll",
            "Home/End",
            "Enter chat",
            "d details",
            "x stop",
            entry?.elsewhere ? "c copy report" : undefined,
            "Esc close",
        ];

        return cell(
            this.theme.fg("dim", hints.filter((hint) => hint !== undefined).join(" · ")),
            width,
        );
    }

    private moveSelection(step: number): void {
        const entries = this.entries();
        const index = entries.findIndex((entry) => entry.run.id === this.selectedId);
        const next = entries[Math.min(entries.length - 1, Math.max(0, index + step))];

        if (next) {
            this.select(next.run.id);
        }
    }

    private select(runId: string): void {
        if (runId === this.selectedId) {
            return;
        }

        this.selectedId = runId;
        this.details = false;
        this.viewport.follow();
        this.requestRender();
    }

    private scroll(step: number): void {
        if (this.viewport.scrollBy(step)) {
            this.requestRender();
        }
    }

    private startChat(entry: Entry): void {
        const { run } = entry;

        if (entry.elsewhere) {
            this.showNotice(
                `${run.name} belongs to another branch; switch to it to write to the run.`,
                "warning",
            );
            return;
        }

        if (run.readOnly) {
            this.showNotice(
                `${run.name} is read-only: it came here through /fork or /clone.`,
                "warning",
            );
            return;
        }

        const input = new Input({ prompt: "" });

        input.focused = true;
        input.onSubmit = (value) => {
            this.chat = undefined;

            if (value.trim() === "") {
                this.requestRender();
                return;
            }

            this.send(run, value);
        };
        this.chat = input;
        this.requestRender();
    }

    private send(run: Run, text: string): void {
        this.showNotice(`Sending to ${run.name}…`, "muted");

        this.manager.send(run, text, "user").then(
            (outcome) => {
                this.showNotice(
                    outcome === "steered"
                        ? `Sent to ${run.name}; it steers the running turn.`
                        : outcome === "deferred"
                          ? `Sent to ${run.name}; it starts the next turn.`
                          : `Sent to ${run.name}; a new turn started.`,
                    "success",
                );
                this.viewport.follow();
            },
            (error: unknown) => this.showError(`Sending to ${run.name} failed`, error),
        );
    }

    private stop(run: Run): void {
        if (run.state !== "running") {
            this.showNotice(`${run.name} is not running.`, "muted");
            return;
        }

        if (run.readOnly || !this.manager.isOnBranch(run)) {
            this.showNotice(`${run.name} cannot be stopped from here.`, "warning");
            return;
        }

        this.showNotice(`Stopping ${run.name}…`, "muted");
        this.manager.stop(run, "user").then(
            () => this.showNotice(`Stopped ${run.name}.`, "success"),
            (error: unknown) => this.showError(`Stopping ${run.name} failed`, error),
        );
    }

    private copy(entry: Entry): void {
        if (!entry.elsewhere) {
            this.showNotice("Only a run of another branch has a report to copy here.", "muted");
            return;
        }

        try {
            this.manager.copyReport(entry.run);
            this.showNotice(`Copied the last turn of ${entry.run.name} to this branch.`, "success");
        } catch (error) {
            this.showError(`Copying ${entry.run.name} failed`, error);
        }
    }

    /** A failure shows in the footer and stays in Pi's notifications after the panel closes. */
    private showError(prefix: string, error: unknown): void {
        const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;

        this.showNotice(message, "error", ERROR_NOTICE_MS);
        this.ctx.ui.notify(message, "error");
    }

    private showNotice(text: string, color: ThemeColor, durationMs = NOTICE_MS): void {
        if (this.disposed) {
            return;
        }

        this.notice = { text: truncateToWidth(displayLine(text), 400), color };
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => {
            this.notice = undefined;
            this.requestRender();
        }, durationMs);
        this.requestRender();
    }

    /** A running tool shows its elapsed time, so the panel redraws while the selected run has one. */
    private syncRefreshTimer(selected: Run | undefined): void {
        const running = !this.details && (selected?.runningTools.size ?? 0) > 0;

        if (running && !this.refreshTimer && !this.disposed) {
            this.refreshTimer = setInterval(() => this.requestRender(), REFRESH_INTERVAL_MS);
        } else if (!running && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }
}

interface Entry {
    run: Run;
    /** The run belongs to another branch: read it, copy its report, nothing else. */
    elsewhere: boolean;
}
