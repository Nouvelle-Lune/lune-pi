import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SEPARATOR, SHOW_MORE } from "./style.ts";

/** A clickable hint that trails its row; the lead is truncated before the hint ever is. */
export class Disclosure {
    private row = -1;
    private column = 0;
    private length = 0;

    reset() {
        this.row = -1;
    }
    render(
        theme: Theme,
        width: number,
        row: number,
        hovered: boolean,
        lead = "",
        text = SHOW_MORE,
    ): string {
        const available = Math.max(0, width);
        const joinerWidth = lead.trim() ? visibleWidth(SEPARATOR) : 0;
        const room = available - visibleWidth(text) - joinerWidth;
        // Below the hint's own width the lead and joiner give way so the row never overflows.
        const head = lead && room > 0 ? truncateToWidth(lead, room, "…") : "";
        const joiner = head.trim() ? theme.fg("dim", SEPARATOR) : "";
        const label = truncateToWidth(
            text,
            Math.max(0, available - visibleWidth(head) - visibleWidth(joiner)),
            "",
        );
        this.row = row;
        this.column = visibleWidth(head) + visibleWidth(joiner);
        this.length = visibleWidth(label);
        return head + joiner + theme.fg(hovered ? "accent" : "dim", label);
    }
    contains(event: TuiMouseEvent): boolean {
        return (
            event.y === this.row && event.x >= this.column && event.x < this.column + this.length
        );
    }
}
