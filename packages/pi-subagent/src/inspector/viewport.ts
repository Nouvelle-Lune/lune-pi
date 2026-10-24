export interface ViewportWindow {
    start: number;
    /** Rows below the window that the user has not seen yet. */
    newestHidden: number;
}

/**
 * Which rows of a transcript the pane shows.
 *
 * The position is an absolute anchor, the first visible row, and `undefined` follows the newest
 * row. That makes scrolling a pause: a tail-relative offset would drag the view along while the
 * run streams and the user reads.
 */
export class Viewport {
    private anchor: number | undefined;
    /** Rows the last frame could show; key handling needs it to clamp the anchor. */
    private capacity = 0;
    private total = 0;

    get paused(): boolean {
        return this.anchor !== undefined;
    }

    /** Fit the view to a frame; landing on the newest rows means following again. */
    window(total: number, capacity: number): ViewportWindow {
        this.capacity = capacity;
        this.total = total;

        const tailStart = Math.max(0, total - capacity);
        const start = this.anchor === undefined ? tailStart : Math.min(this.anchor, tailStart);

        this.anchor = start >= tailStart ? undefined : start;

        return { start, newestHidden: Math.max(0, total - (start + capacity)) };
    }

    /** Returns whether the view moved. */
    scrollBy(step: number): boolean {
        if (this.capacity === 0 || (this.anchor === undefined && step > 0)) {
            return false;
        }

        const tailStart = Math.max(0, this.total - this.capacity);
        const previous = this.anchor ?? tailStart;

        this.anchor = Math.min(tailStart, Math.max(0, previous + step));

        if (this.anchor >= tailStart) {
            this.anchor = undefined;
        }

        return (this.anchor ?? tailStart) !== previous;
    }

    jumpToOldest(): void {
        this.anchor = 0;
    }

    follow(): void {
        this.anchor = undefined;
    }
}
