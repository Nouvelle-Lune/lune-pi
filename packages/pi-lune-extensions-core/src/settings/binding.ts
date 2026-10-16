/**
 * Native Pi adapter that owns configuration readiness, never business event dispatch.
 *
 * Each session_start unpublishes its view before retiring the preceding lease.
 * Session identity includes cwd, manager identity and session ID: matching only cwd
 * would let old contexts use new-session state. session_shutdown retires the binding.
 * Project trust is captured from that session's context. Outcome captures acquisition
 * failure for later view/dispose callers; only an explicit retry acquires again.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { acquireSettings, SettingsAcquisitionCleanupError } from "./acquire.ts";
import type { SettingsDefinition } from "./definition.ts";
import type { SettingsLease, SettingsView } from "./types.ts";

/** Minimal session identity needed for view access; UI/model services are irrelevant. */
export interface SettingsContext {
    readonly cwd: string;
    readonly sessionManager: { getSessionId(): string };
}

/**
 * Extension-owned binding whose views are session-local and borrowed by business/UI.
 * Handles are local to their Core copy; dependent Panels must use that same copy.
 * This object cannot be restarted after disposal; create a new binding on extension reload.
 */
export interface SettingsBinding<T extends TObject> {
    readonly definition: SettingsDefinition<T>;
    /** Binding lifetime; individual view signals also retire on session replacement. */
    readonly signal: AbortSignal;
    /**
     * Await the current acquisition, then recheck identity/retirement.
     * Reject before startup, for foreign/old contexts, on acquisition failure or after
     * disposal. Repeated calls share the current view, not independent release rights.
     */
    view(context: SettingsContext): Promise<SettingsView<T>>;
    /** Stop hooks/abort lifetime synchronously; await pending acquisition and owned cleanup. */
    dispose(): Promise<void>;
}

/**
 * Internal readiness published to dependents. A failed state keeps the error visible
 * and offers an explicit retry for the same session; it never retries on its own.
 * @internal
 */
export type SettingsBindingState<T extends TObject> =
    | {
          readonly status: "ready";
          readonly context: ExtensionContext;
          readonly view: SettingsView<T>;
      }
    | {
          readonly status: "failed";
          readonly context: ExtensionContext;
          readonly error: unknown;
          /** Acquire again for the same session; rejects with the new failure. */
          retry(): Promise<void>;
      };
type BindingListener<T extends TObject> = (state: SettingsBindingState<T> | undefined) => void;
const bindingObservers = new WeakMap<object, unknown>();

/** @internal Observe current readiness without adding a public lifecycle API. */
export function observeSettingsBinding<T extends TObject>(
    binding: SettingsBinding<T>,
    listener: BindingListener<T>,
): () => void {
    binding.signal.throwIfAborted();
    const observe = bindingObservers.get(binding) as
        | ((listener: BindingListener<T>) => () => void)
        | undefined;
    if (!observe)
        throw new TypeError(
            "Settings binding must be created by bindSettings from the same Core copy",
        );
    return observe(listener);
}

type Outcome<T extends TObject> =
    | { ok: true; lease: SettingsLease<T> }
    | { ok: false; error: unknown; cleanupError?: unknown };
type Session<T extends TObject> = {
    cwd: string;
    manager: SettingsContext["sessionManager"];
    id: string;
    retired: boolean;
    ready: Promise<Outcome<T>>;
    lease?: SettingsLease<T>;
    cleanup?: Promise<void>;
};

/**
 * Install configuration session_start/session_shutdown hooks on the native Pi API.
 *
 * Call during the extension factory, before registering business startup hooks.
 * Panels observe current readiness internally, including when registered after startup.
 * The startup callback acquires storage in every host mode, including
 * RPC/print; callbacks that need values must await binding.view(ctx).
 * Shutdown/dispose releases only this binding's lease and aggregates cleanup failures.
 *
 * The binding does not wrap business handlers, select models or implicitly open UI.
 * If setup of a later dependency fails, its owner must still dispose this binding.
 */
export function bindSettings<T extends TObject>(
    pi: ExtensionAPI,
    definition: SettingsDefinition<T>,
): SettingsBinding<T> {
    const lifetime = new AbortController();
    const listeners: (() => void)[] = [];
    let current: Session<T> | undefined;
    let disposal: Promise<void> | undefined;
    let published: SettingsBindingState<T> | undefined;
    const observers = new Set<() => void>();
    const publish = (state: SettingsBindingState<T> | undefined) => {
        if (published === state) return;
        published = state;
        const errors: unknown[] = [];
        for (const notify of [...observers]) {
            if (!observers.has(notify)) continue;
            try {
                notify();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Settings binding observers failed");
    };
    const retired = () =>
        new DOMException(`Settings binding "${definition.id}" is retired`, "AbortError");
    const close = (session: Session<T> | undefined): Promise<void> => {
        if (!session) return Promise.resolve();
        if (session.cleanup) return session.cleanup;
        session.retired = true;
        session.cleanup = Promise.resolve().then(async () => {
            const result = await session.ready;
            if (result.ok) await result.lease.release();
            else if (session.lease) await session.lease.release();
            else if (result.cleanupError !== undefined) throw result.cleanupError;
        });
        // Release invalidates a ready view synchronously, before dependents can accept more work.
        if (session.lease) void session.lease.release().catch(() => {});
        return session.cleanup;
    };
    const assertCurrent = (session: Session<T>) => {
        lifetime.signal.throwIfAborted();
        if (current !== session || session.retired) throw retired();
    };
    const binding: SettingsBinding<T> = {
        definition,
        signal: lifetime.signal,
        async view(context) {
            lifetime.signal.throwIfAborted();
            const session = current;
            if (!session) throw new Error(`Settings "${definition.id}" have not started`);
            if (
                context.cwd !== session.cwd ||
                context.sessionManager !== session.manager ||
                context.sessionManager.getSessionId() !== session.id
            )
                throw new Error(
                    `Settings "${definition.id}" context does not belong to its current session`,
                );
            assertCurrent(session);
            const result = await session.ready;
            assertCurrent(session);
            if (!result.ok) throw result.error;
            result.lease.settings.signal.throwIfAborted();
            return result.lease.settings;
        },
        dispose() {
            if (disposal) return disposal;
            const previous = current;
            current = undefined;
            const errors: unknown[] = [];
            disposal = Promise.resolve().then(async () => {
                try {
                    await close(previous);
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length)
                    throw new AggregateError(errors, "Settings binding cleanup failed");
            });
            // Dependents must unmount while their borrowed view is still usable.
            try {
                publish(undefined);
            } catch (error) {
                errors.push(error);
            }
            observers.clear();
            lifetime.abort(retired());
            for (const unsubscribe of listeners.splice(0).reverse()) {
                try {
                    unsubscribe();
                } catch (error) {
                    errors.push(error);
                }
            }
            void close(previous).catch(() => {});
            return disposal;
        },
    };
    bindingObservers.set(binding, (listener: BindingListener<T>) => {
        const notify = () => listener(published);
        if (!lifetime.signal.aborted) observers.add(notify);
        try {
            notify();
        } catch (error) {
            observers.delete(notify);
            throw error;
        }
        return () => {
            observers.delete(notify);
        };
    });
    const start = async (context: ExtensionContext): Promise<void> => {
        lifetime.signal.throwIfAborted();
        const previous = current;
        const session: Session<T> = {
            cwd: context.cwd,
            manager: context.sessionManager,
            id: context.sessionManager.getSessionId(),
            retired: false,
            ready: undefined as never,
        };
        // Trust can change between sessions; each acquisition uses its own context's decision.
        const projectTrusted = context.isProjectTrusted();
        // Publish the generation before async cleanup so view() waits on this session only.
        current = session;
        session.ready = Promise.resolve().then(async (): Promise<Outcome<T>> => {
            try {
                try {
                    await close(previous);
                } catch (error) {
                    return { ok: false, error, cleanupError: error };
                }
                assertCurrent(session);
                const lease = await acquireSettings(definition, {
                    cwd: session.cwd,
                    projectTrusted,
                });
                // Acquisition may settle after shutdown/replacement; ownership still needs release.
                session.lease = lease;
                if (session.retired || current !== session || lifetime.signal.aborted) {
                    await lease.release();
                    throw retired();
                }
                return { ok: true, lease };
            } catch (error) {
                return {
                    ok: false,
                    error,
                    cleanupError:
                        error instanceof SettingsAcquisitionCleanupError
                            ? error.cleanupError
                            : undefined,
                };
            }
        });
        publish(undefined);
        const result = await session.ready;
        if (!result.ok) {
            // Dependents show the failure so users can repair storage and retry in place.
            if (current === session && !session.retired && !lifetime.signal.aborted)
                publish({
                    status: "failed",
                    context,
                    error: result.error,
                    retry: () => {
                        if (current !== session || session.retired)
                            return Promise.reject(retired());
                        return start(context);
                    },
                });
            throw result.error;
        }
        assertCurrent(session);
        publish({ status: "ready", context, view: result.lease.settings });
    };
    try {
        listeners.push(pi.on("session_start", (_event, context) => start(context)));
        listeners.push(pi.on("session_shutdown", () => binding.dispose()));
    } catch (error) {
        void binding.dispose().catch(() => {});
        throw error;
    }
    return binding;
}
