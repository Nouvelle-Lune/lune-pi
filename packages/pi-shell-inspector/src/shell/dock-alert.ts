/** How long a failure keeps a Dock item's error marker when nobody opens the item's panel. */
export const ALERT_DURATION_MS = 10_000;

/**
 * The lifetime of a Dock item's error marker. A failure shows from the time it happened until
 * `ALERT_DURATION_MS` later, or until the user sees it in the item's panel. A check that finds a
 * failure still showing also schedules the redraw that ends it, so a quiet screen does not keep
 * the marker.
 */
export class DockAlerts {
    private readonly seen = new Set<string>();
    /** A failure without a known time starts its window when it is first checked. */
    private readonly firstChecked = new Map<string, number>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private dueAt = Infinity;
    private readonly redraw: () => void;

    constructor(redraw: () => void) {
        this.redraw = redraw;
    }

    /** Whether the failure `key`, which happened at `at`, still shows the marker. */
    shows(key: string, at: number | undefined): boolean {
        if (this.seen.has(key)) {
            return false;
        }

        const now = Date.now();
        const since = at ?? this.firstChecked.get(key) ?? now;

        if (at === undefined) {
            this.firstChecked.set(key, since);
        }

        const endsAt = since + ALERT_DURATION_MS;

        if (endsAt <= now) {
            return false;
        }

        if (endsAt < this.dueAt) {
            clearTimeout(this.timer);
            this.dueAt = endsAt;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.dueAt = Infinity;
                this.redraw();
            }, endsAt - now);
        }

        return true;
    }

    /** The user saw the failure in the item's panel. False when it was seen before. */
    acknowledge(key: string): boolean {
        if (this.seen.has(key)) {
            return false;
        }

        this.seen.add(key);

        return true;
    }

    forget(key: string): void {
        this.seen.delete(key);
        this.firstChecked.delete(key);
    }

    /** Forgets every failure and stops the pending redraw, so a detached item draws nothing late. */
    clear(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.dueAt = Infinity;
        this.seen.clear();
        this.firstChecked.clear();
    }
}
