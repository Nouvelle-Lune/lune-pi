import type { Theme } from "@earendil-works/pi-coding-agent";
import { animationFrame, type CallStatus } from "../renderer/tool/activity.ts";

// Every Lune surface shares this vocabulary so cards, call trees and thinking read as one system.
export const SEPARATOR = " · ";
export const SHOW_MORE = "click to show more";
export const BRANCH = "├";
export const LAST_BRANCH = "└";
// A running call waxes through the moon; settled calls are full or new moons.
const MOON_PHASES = ["◐", "◓", "◑", "◒"] as const;

function statusColor(status: CallStatus) {
    return status === "running"
        ? "accent"
        : status === "failed"
          ? "error"
          : status === "cancelled"
            ? "dim"
            : "success";
}

export function statusMark(status: CallStatus, theme: Theme): string {
    const mark =
        status === "running"
            ? MOON_PHASES[animationFrame() % MOON_PHASES.length]!
            : status === "cancelled"
              ? "○"
              : "●";
    return theme.fg(statusColor(status), mark);
}

/** Done is implied by its mark; failures and cancellations stay readable without color. */
export function statusLabel(status: CallStatus, theme: Theme): string {
    return status === "failed"
        ? theme.fg("error", "failed")
        : status === "cancelled"
          ? theme.fg("dim", "cancelled")
          : "";
}

/** Plain parts are dimmed; pre-styled parts keep their own color. */
export function meta(theme: Theme, parts: readonly (string | undefined)[]): string {
    return parts
        .filter((part): part is string => !!part)
        .map((part) => (part.includes("\x1b[") ? part : theme.fg("dim", part)))
        .join(theme.fg("dim", SEPARATOR));
}

export function sectionLabel(theme: Theme, label: string): string {
    return theme.fg("dim", label);
}

export function branch(theme: Theme, last: boolean): string {
    return theme.fg("border", last ? LAST_BRANCH : BRANCH);
}
