import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { meta, SEPARATOR, statusLabel, statusMark } from "../../ui/style.ts";
import type { CallStatus } from "./activity.ts";
import { fitSummary } from "./summary.ts";

export function formatDuration(milliseconds: number | undefined): string {
    if (milliseconds === undefined) return "";
    const seconds = milliseconds / 1000;
    return seconds < 1
        ? `${Math.round(milliseconds)}ms`
        : seconds < 60
          ? `${seconds.toFixed(1)}s`
          : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

// Cards and call trees share one row: mark, name, summary, then outcome metadata beside the command.
export function renderToolLine(
    theme: Theme,
    width: number,
    call: {
        name: string;
        summary: string;
        status: CallStatus;
        durationMs?: number;
        detail?: string;
    },
    prefix = "",
): string {
    const title = `${prefix}${statusMark(call.status, theme)} ${theme.fg("toolTitle", call.name)}`;
    const tail = meta(theme, [
        statusLabel(call.status, theme),
        call.detail,
        formatDuration(call.durationMs),
    ]);
    const tailWidth = tail ? visibleWidth(SEPARATOR) + visibleWidth(tail) : 0;
    const room = Math.max(0, width - visibleWidth(title) - tailWidth - 2);
    const summary = fitSummary(call.summary, room, config.toolLabelClip || 80);
    const head = summary ? `${title}  ${theme.fg("muted", summary)}` : title;
    return tail ? `${head}${theme.fg("dim", SEPARATOR)}${tail}` : head;
}

/** Only non-zero outcomes that need attention; empty parts are dropped by `meta`. */
export function attentionCounts(theme: Theme, statuses: readonly CallStatus[]): string[] {
    const count = (status: CallStatus) => statuses.filter((value) => value === status).length;
    const running = count("running");
    const failed = count("failed");
    const cancelled = count("cancelled");
    return [
        running ? theme.fg("accent", `${running} running`) : "",
        failed ? theme.fg("error", `${failed} failed`) : "",
        cancelled ? `${cancelled} cancelled` : "",
    ];
}

/** Totals lead; only non-zero outcomes that need attention follow. */
export function callCounts(theme: Theme, statuses: readonly CallStatus[]): string {
    return meta(theme, [
        `${statuses.length} ${statuses.length === 1 ? "call" : "calls"}`,
        ...attentionCounts(theme, statuses),
    ]);
}
