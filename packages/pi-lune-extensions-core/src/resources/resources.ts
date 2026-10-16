/**
 * Local ownership primitive: use this for cleanup, not shared runtime discovery.
 * No resources are acquired by construction and no lifecycle hooks are inferred.
 */

/** A caller-owned resource whose disposal may need asynchronous completion. */
export interface DisposableResource {
    dispose(): void | Promise<void>;
}

/**
 * Own related resources and dispose dependents before their dependencies.
 *
 * Register dependencies first, dependents last. Resources passed to use are deduped
 * by identity; defer callbacks are distinct acquisitions. Disposal closes the scope
 * synchronously, attempts all cleanup in reverse order, and shares one promise even
 * when re-entered. Failures aggregate instead of skipping the remaining resources.
 */
export class ResourceScope implements DisposableResource {
    private readonly releases: (() => void | Promise<void>)[] = [];
    private readonly owned = new WeakSet<object>();
    private disposal?: Promise<void>;
    private closed = false;

    /** Transfer ownership once per object identity; throws after scope retirement. */
    use<T extends DisposableResource>(resource: T): T {
        this.assertOpen();
        if (!this.owned.has(resource)) {
            this.owned.add(resource);
            this.defer(() => resource.dispose());
        }
        return resource;
    }

    /** Own one cleanup callback; unlike use, repeated callbacks are not deduplicated. */
    defer(release: () => void | Promise<void>): void {
        this.assertOpen();
        this.releases.push(release);
    }

    /**
     * Own a subscription and return an early, idempotent release handle.
     * Synchronous notification during subscribe may retire the scope; the newly
     * returned unsubscribe is then called immediately rather than leaked.
     */
    subscribe<T>(
        source: { subscribe(listener: (value: T) => void): () => void },
        listener: (value: T) => void,
    ): () => void {
        this.assertOpen();
        const unsubscribe = source.subscribe(listener);
        let active = true;
        const release = () => {
            if (!active) return;
            active = false;
            unsubscribe();
        };
        // Observable sources may synchronously notify during subscription.
        if (this.closed) release();
        else this.defer(release);
        return release;
    }

    /**
     * Reject new acquisitions immediately, then await every owned cleanup.
     * Repeated calls share completion/failure; AggregateError retains all failures.
     */
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.closed = true;
        // Publish the promise before invoking a disposer that could re-enter its owner.
        this.disposal = Promise.resolve().then(async () => {
            const errors: unknown[] = [];
            for (const release of this.releases.splice(0).reverse()) {
                try {
                    await release();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length) throw new AggregateError(errors, "Resource cleanup failed");
        });
        return this.disposal;
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("Resource owner is disposed");
    }
}
