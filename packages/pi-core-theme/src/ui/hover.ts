/** One hover target per interactive session; motion over unrelated UI clears it after native dispatch. */
export class HoverState {
    private target: object | undefined;
    private generation = 0;
    private revision = 0;
    get version() {
        return this.revision;
    }
    private visited = false;
    has(target: object) {
        return this.target === target;
    }
    focus(target: object) {
        this.visited = true;
        const changed = this.target !== target;
        this.target = target;
        if (changed) this.revision++;
        return changed;
    }
    blur(target: object) {
        if (this.target !== target) return false;
        this.target = undefined;
        this.revision++;
        return true;
    }
    beginMove(repaint: () => void) {
        this.visited = false;
        const generation = ++this.generation;
        queueMicrotask(() => {
            if (generation !== this.generation || this.visited || !this.target) return;
            this.target = undefined;
            this.revision++;
            repaint();
        });
    }
    clear() {
        this.generation++;
        if (this.target) this.revision++;
        this.target = undefined;
    }
}

/** Fullscreen consumes motion before extension listeners; observe its session instance before native dispatch. */
export function installHoverTracking(tui: object, hover: HoverState, repaint: () => void) {
    const host = tui as { handleViewportInput?: (data: string) => unknown };
    const original = host.handleViewportInput;
    if (typeof original !== "function") return () => {};
    const owned = Object.hasOwn(host, "handleViewportInput");
    const handler = function (this: typeof host, data: string) {
        const mouse = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
        if (mouse && (Number(mouse[1]) & 32) !== 0) hover.beginMove(repaint);
        return original.call(this, data);
    };
    host.handleViewportInput = handler;
    return () => {
        if (host.handleViewportInput !== handler) return;
        if (owned) host.handleViewportInput = original;
        else delete host.handleViewportInput;
    };
}
