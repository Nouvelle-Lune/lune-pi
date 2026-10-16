import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { callCounts } from "../renderer/tool/presentation.ts";
import { overallStatus, type CallStatus } from "../renderer/tool/activity.ts";
import { Disclosure } from "./disclosure.ts";
import { statusMark } from "./style.ts";

const PREVIEW_LIMIT = 5;

// Grouped tools and codemode share two opening targets; the expanded panel owns closing clicks.
export class CallList {
    private readonly header = new Disclosure();
    private readonly overflow = new Disclosure();

    reset() {
        this.header.reset();
        this.overflow.reset();
    }
    previewCount(total: number, expanded: boolean): number {
        return expanded ? total : Math.min(total, PREVIEW_LIMIT, config.previewLines);
    }
    previewStart(total: number, expanded: boolean, running: boolean, current = total - 1): number {
        if (expanded || !running) return 0;
        const count = this.previewCount(total, expanded);
        return Math.max(0, Math.min(total - count, current - count + 1));
    }
    /** `indent` is part of the returned row so hint hit-testing matches what is painted. */
    renderHeader(
        theme: Theme,
        width: number,
        label: string,
        statuses: readonly CallStatus[],
        expanded: boolean,
        hovered: boolean,
        indent = "",
        parentStatus?: CallStatus,
    ): string {
        const status = overallStatus(parentStatus ? [...statuses, parentStatus] : statuses);
        const title = `${indent}${statusMark(status, theme)} ${theme.bold(theme.fg("toolTitle", label))}  ${callCounts(theme, statuses)}`;
        if (expanded) return truncateToWidth(title, width, "…");
        return this.header.render(theme, width, 0, hovered, title);
    }
    renderOverflow(
        theme: Theme,
        width: number,
        row: number,
        total: number,
        expanded: boolean,
        hovered: boolean,
        indent = "",
    ): string[] {
        const hidden = total - this.previewCount(total, expanded);
        if (expanded || hidden <= 0) return [];
        const text = `… ${hidden} more ${hidden === 1 ? "call" : "calls"}`;
        return [this.overflow.render(theme, width, row, hovered, indent, text)];
    }
    contains(event: TuiMouseEvent): boolean {
        return this.header.contains(event) || this.overflow.contains(event);
    }
}
