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

/** Wraps one method of a TUI instance; the undo leaves a newer wrapper in place. */
export function patchMethod<F extends (...args: never[]) => unknown>(
    host: object,
    name: string,
    wrap: (original: F) => F,
) {
    const target = host as Record<string, unknown>;
    const original = target[name];
    if (typeof original !== "function") return () => {};
    const owned = Object.hasOwn(target, name);
    const patched = wrap(original as F);
    target[name] = patched;
    return () => {
        if (target[name] !== patched) return;
        if (owned) target[name] = original;
        else delete target[name];
    };
}

/** Fullscreen consumes motion before extension listeners; observe its session instance before native dispatch. */
export function installHoverTracking(tui: object, hover: HoverState, repaint: () => void) {
    return patchMethod<(data: string) => unknown>(
        tui,
        "handleViewportInput",
        (original) =>
            function (this: unknown, data) {
                const mouse = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
                if (mouse && (Number(mouse[1]) & 32) !== 0) hover.beginMove(repaint);
                return original.call(this, data);
            },
    );
}
