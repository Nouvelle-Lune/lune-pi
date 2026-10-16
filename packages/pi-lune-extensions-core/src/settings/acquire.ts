/**
 * Ownership firewall between storage backends and consumer Settings views.
 *
 * acquireSettings validates the declaration, acquires one backend obligation, checks
 * its identity/schema, and wraps it without exposing transactions or backend release.
 * leaseView isolates values/subscriptions, enforces the trust and global-only scope
 * policy for every backend, and drains accepted work on retirement. Native session
 * binding is separate; manual callers must always release their lease.
 */
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { Static, TObject } from "typebox";
import { acquireFileBackend } from "./file-backend.ts";
import {
    defineSettings,
    freezeValue,
    schemaAtPath,
    type SettingsDefinition,
} from "./definition.ts";
import type { SettingsBackend } from "./backend.ts";
import type {
    DeepReadonly,
    SettingsField,
    SettingsKey,
    SettingsLease,
    SettingsScope,
    SettingsView,
    SettingInspection,
} from "./types.ts";

/**
 * Where an explicit acquisition reads from. projectTrusted mirrors Pi's
 * ctx.isProjectTrusted(): false keeps project files unread and unwritten.
 */
export interface SettingsAcquisitionContext {
    readonly cwd: string;
    readonly projectTrusted: boolean;
}

/**
 * Acquisition failed and its rollback failed too; retain both causes.
 * Binding startup uses cleanupError to surface unfinished cleanup again on disposal.
 * @internal
 */
export class SettingsAcquisitionCleanupError extends AggregateError {
    readonly cleanupError: unknown;
    constructor(error: unknown, cleanupError: unknown) {
        super([error, cleanupError], "Settings acquisition and cleanup failed");
        this.cleanupError = cleanupError;
    }
}

/**
 * Acquire one manually owned lease; no Pi lifecycle or UI hooks are installed.
 *
 * The optional custom factory must return ready storage. Without it, acquisition
 * loads the Pi SDK to resolve global/project files, upgrades older files through the
 * declaration's migrations and reuses compatible shared state. A backend ID/schema
 * mismatch rolls back ownership instead of publishing a view.
 *
 * @param definition Persistence declaration; cloned/validated again at acquisition.
 * @param context cwd identifies the project; projectTrusted must reflect Pi's trust
 *     decision for it, because untrusted project files are neither read nor written.
 * @returns An isolated view and an idempotent release obligation for this caller only.
 * @throws Acquisition/validation errors; rollback failures aggregate both causes.
 */
export async function acquireSettings<T extends TObject>(
    definition: SettingsDefinition<T>,
    context: SettingsAcquisitionContext,
): Promise<SettingsLease<T>> {
    if (typeof context.projectTrusted !== "boolean")
        throw new TypeError("acquireSettings requires an explicit projectTrusted boolean");
    const validated = defineSettings(definition);
    const owned = validated.backend
        ? await validated.backend({ cwd: context.cwd, projectTrusted: context.projectTrusted })
        : await acquireFileBackend({
              id: validated.id,
              schema: validated.schema,
              cwd: context.cwd,
              projectTrusted: context.projectTrusted,
              migrations: validated.migrations,
              globalOnly: validated.globalOnly,
          });
    try {
        if (
            owned.backend.id !== validated.id ||
            !isDeepStrictEqual(owned.backend.settingSchema, validated.schema)
        )
            throw new TypeError(`Backend does not match settings definition "${validated.id}"`);
        return leaseView(owned.backend, () => owned.release(), {
            scopes: context.projectTrusted ? ["global", "project"] : ["global"],
            globalOnly: new Set(validated.globalOnly),
        });
    } catch (error) {
        try {
            await owned.release();
        } catch (cleanupError) {
            throw new SettingsAcquisitionCleanupError(error, cleanupError);
        }
        throw error;
    }
}

/**
 * Read global values once, for decisions made while an extension factory runs.
 *
 * Factories run before Pi resolves a session's project trust, so project files are
 * deliberately ignored: the result is global -> default only. Use bindSettings and
 * view(ctx) for project-aware values once a session has started.
 */
export async function readGlobalSettings<T extends TObject>(
    definition: SettingsDefinition<T>,
): Promise<DeepReadonly<Static<T>>> {
    const lease = await acquireSettings(definition, { cwd: process.cwd(), projectTrusted: false });
    let values: DeepReadonly<Static<T>>;
    try {
        values = lease.settings.snapshot({ scope: "global" });
    } catch (error) {
        await lease.release();
        throw error;
    }
    await lease.release();
    return values;
}

/**
 * Preserve shared backend state while making read/write/subscription lifetime local.
 * Publish pending operations before invoking storage because observers may synchronously
 * call release. Retirement closes capabilities immediately but drains accepted writes.
 * Scope policy is enforced here as well as in storage so custom backends cannot leak
 * project values into untrusted or global-only reads.
 */
function leaseView<T extends TObject>(
    backend: SettingsBackend<T>,
    releaseBackend: () => void | Promise<void>,
    policy: { scopes: readonly SettingsScope[]; globalOnly: ReadonlySet<string> },
): SettingsLease<T> {
    const scopes = Object.freeze([...policy.scopes]);
    const scopesFor = (key: string): readonly SettingsScope[] =>
        policy.globalOnly.has(key) ? Object.freeze(["global"] as const) : scopes;
    const lifetime = new AbortController();
    let released = false;
    let releaseResult: Promise<void> | undefined;
    const subscriptions = new Set<() => void>();
    const pending = new Set<Promise<unknown>>();
    const assertActive = () => {
        if (released) throw new Error(`Settings lease "${backend.id}" is released`);
    };
    const inspect = <K extends SettingsKey<T>>(key: K) => {
        assertActive();
        const inspection = Value.Clone(backend.inspect(key));
        if (inspection.projectValue !== undefined && !scopesFor(key).includes("project"))
            throw new TypeError(
                `Backend "${backend.id}" returned a project value for "${key}" outside its permitted scopes`,
            );
        return inspection;
    };
    // Reject before storage so the policy holds for custom backends too.
    const assertWritable = (key: string, scope: SettingsScope | undefined) => {
        if (scope !== undefined && scope !== "global" && scope !== "project")
            throw new TypeError(`Unknown settings scope "${scope}"`);
        if (scope !== "project" || scopesFor(key).includes("project")) return;
        throw new TypeError(
            policy.globalOnly.has(key)
                ? `Setting "${key}" for "${backend.id}" can only be stored globally`
                : `Project settings for "${backend.id}" are disabled because the project is not trusted`,
        );
    };
    const write = (
        key: string,
        scope: SettingsScope | undefined,
        operation: () => Promise<void>,
    ) => {
        assertActive();
        try {
            assertWritable(key, scope);
        } catch (error) {
            return Promise.reject(error);
        }
        return track(operation);
    };
    const track = <R>(operation: () => Promise<R>): Promise<R> => {
        assertActive();
        let resolve!: (value: R | PromiseLike<R>) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<R>((accept, fail) => {
            resolve = accept;
            reject = fail;
        });
        // A backend may synchronously notify a listener that releases this lease.
        pending.add(result);
        void result.then(
            () => pending.delete(result),
            () => pending.delete(result),
        );
        try {
            resolve(operation());
        } catch (error) {
            reject(error);
            throw error;
        }
        return result;
    };
    const view: SettingsView<T> = {
        id: backend.id,
        signal: lifetime.signal,
        scopes,
        get: (key) => inspect(key).value,
        inspect,
        snapshot(options = {}) {
            assertActive();
            if (
                options.scope !== undefined &&
                options.scope !== "global" &&
                options.scope !== "project"
            )
                throw new TypeError(`Unknown settings scope "${options.scope}"`);
            return freezeValue(
                Object.fromEntries(
                    Object.keys(backend.settingSchema.properties).map((key) => {
                        const value = inspect(key as SettingsKey<T>);
                        return [
                            key,
                            options.scope === "global"
                                ? value.globalValue !== undefined
                                    ? value.globalValue
                                    : value.defaultValue
                                : value.value,
                        ];
                    }),
                ),
            ) as ReturnType<SettingsView<T>["snapshot"]>;
        },
        set: (key, value, options) =>
            write(key, options?.scope, () => backend.set(key, value, options)),
        reset: (key, options) => write(key, options?.scope, () => backend.reset(key, options)),
        reload: () => track(() => backend.reload()),
        subscribe(listener) {
            assertActive();
            const unsubscribe = backend.subscribe(listener);
            let active = true;
            const release = () => {
                if (!active) return;
                active = false;
                subscriptions.delete(release);
                unsubscribe();
            };
            // Registration itself may synchronously notify and retire the lease.
            if (released) release();
            else subscriptions.add(release);
            return release;
        },
        field(input) {
            assertActive();
            const path = typeof input === "string" ? [input] : ([...input] as string[]);
            const schema = schemaAtPath(backend.settingSchema, path);
            const root = path[0]! as SettingsKey<T>;
            if (path.length > 1 && !backend.update)
                throw new TypeError(
                    `Backend "${backend.id}" does not support atomic nested settings edits`,
                );
            const read = (value: unknown): unknown => {
                for (const key of path.slice(1)) value = (value as Record<string, unknown>)[key];
                return value;
            };
            const nestedInspect = (): SettingInspection<unknown> => {
                const inspection = inspect(root);
                return {
                    defaultValue: read(inspection.defaultValue),
                    globalValue:
                        inspection.globalValue === undefined
                            ? undefined
                            : read(inspection.globalValue),
                    projectValue:
                        inspection.projectValue === undefined
                            ? undefined
                            : read(inspection.projectValue),
                    value: read(inspection.value),
                    source: inspection.source,
                };
            };
            const update = (
                value: unknown,
                reset: boolean,
                options?: { scope?: SettingsScope },
            ) => {
                if (path.length === 1)
                    return reset
                        ? view.reset(root, options)
                        : view.set(root, value as Static<T>[typeof root], options);
                return write(root, options?.scope, () =>
                    backend.update!(
                        root,
                        (current, inherited) => {
                            const next = Value.Clone(current);
                            let parent = next as Record<string, unknown>;
                            for (const key of path.slice(1, -1))
                                parent = parent[key] as Record<string, unknown>;
                            Object.defineProperty(parent, path.at(-1)!, {
                                value: reset ? Value.Clone(read(inherited)) : Value.Clone(value),
                                enumerable: true,
                                configurable: true,
                                writable: true,
                            });
                            // Reset removes a redundant whole-object override, not unrelated siblings.
                            return reset && isDeepStrictEqual(next, inherited) ? undefined : next;
                        },
                        options,
                    ),
                );
            };
            return {
                path: Object.freeze(path),
                schema,
                scopes: scopesFor(root),
                get: () => nestedInspect().value,
                inspect: nestedInspect,
                set: (value: unknown, options?: { scope?: SettingsScope }) => {
                    assertActive();
                    if (!Value.Check(schema, value))
                        return Promise.reject(
                            new TypeError(
                                `Invalid value for settings path ${JSON.stringify(path)}`,
                            ),
                        );
                    return update(Value.Clone(value), false, options);
                },
                reset: (options?: { scope?: SettingsScope }) => update(undefined, true, options),
            } as unknown as SettingsField<never>;
        },
    };
    return {
        settings: view,
        release() {
            if (releaseResult) return releaseResult;
            released = true;
            const errors: unknown[] = [];
            // No new work can enter after released=true; drain only this lease's accepted work.
            // Their failures already reached their own callers, so they are not cleanup errors.
            const draining = [...pending];
            // Publish before calling user cleanup, which can re-enter release().
            releaseResult = Promise.resolve().then(async () => {
                await Promise.allSettled(draining);
                try {
                    await releaseBackend();
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length)
                    throw new AggregateError(
                        errors,
                        `Settings lease "${backend.id}" cleanup failed`,
                    );
            });
            lifetime.abort(new Error(`Settings view "${backend.id}" is released`));
            for (const release of [...subscriptions]) {
                try {
                    release();
                } catch (error) {
                    errors.push(error);
                }
            }
            return releaseResult;
        },
    };
}
