/** Mouse expansion has one owner; streaming updates never replace that ownership. */
export class ExpansionState {
    private current: { target: object; collapse: () => void } | undefined;

    get owner(): object | undefined {
        return this.current?.target;
    }

    set(target: object, expanded: boolean, apply: (expanded: boolean) => void) {
        if (expanded) {
            if (this.current?.target !== target) this.collapse();
            this.current = { target, collapse: () => apply(false) };
        } else if (this.current?.target === target) {
            this.current = undefined;
        }
        apply(expanded);
    }

    /** A card that is absorbed into a group keeps its open panel, so ownership follows it. */
    transfer(from: object, to: object, apply: (expanded: boolean) => void) {
        if (this.current?.target === from)
            this.current = { target: to, collapse: () => apply(false) };
    }

    /** The panel is no longer mouse-opened, e.g. Pi's own toggle took over. */
    release(target: object) {
        if (this.current?.target === target) this.current = undefined;
    }

    collapse() {
        const previous = this.current;
        this.current = undefined;
        previous?.collapse();
    }
}
