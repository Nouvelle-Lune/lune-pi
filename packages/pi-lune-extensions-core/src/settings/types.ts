/**
 * Consumer contracts for precedence, isolated values and owned Settings lifetimes.
 *
 * Read this before implementing a backend or calling a view. "global"/"project" are
 * persistence scopes, not model candidate ranges. Whole top-level values inherit;
 * nested field edits are atomic updates of their containing top-level value.
 * Acquisition enforces view ownership; storage implements validation and commits.
 */
import { Value } from "typebox/value";
import { IsOptional } from "typebox";
import type { Static, TObject, TOptional, TSchema } from "typebox";

/** Global overrides defaults; project overrides global. Writes default to global. */
export type SettingsScope = "global" | "project";

/** Compile-time counterpart to assertSettingsSchema: required, defaulted top-level values. */
export type SettingsSchema<TSchema extends TObject> = TSchema & {
    readonly properties: {
        [K in keyof TSchema["properties"]]: TSchema["properties"][K] extends TOptional
            ? never
            : TSchema["properties"][K] & {
                  readonly default: Static<TSchema["properties"][K]>;
              };
    };
};

/**
 * Reject incomplete defaults before a definition/backend can become usable.
 * Checks top-level requiredness, own default properties and TypeBox validity;
 * nested schemas retain their own constraints rather than receiving new defaults.
 */
export function assertSettingsSchema<TSchema extends TObject>(
    schema: TSchema,
): asserts schema is SettingsSchema<TSchema> {
    for (const [key, property] of Object.entries(schema.properties)) {
        if (IsOptional(property)) {
            throw new TypeError(`Setting "${key}" must not be optional`);
        }

        if (!("default" in property) || !Object.hasOwn(property, "default")) {
            throw new TypeError(`Setting "${key}" must define a default value`);
        }

        if (!Value.Check(property, property.default)) {
            throw new TypeError(`Setting "${key}" has an invalid default value`);
        }
    }
}

/**
 * Point-in-time precedence explanation for one top-level value or bound child.
 * Undefined marks an absent override; null, false, zero and empty strings are values.
 * Object settings inherit as a whole: source is the winning top-level scope.
 */
export interface SettingInspection<T> {
    readonly defaultValue: T;

    readonly globalValue: T | undefined;
    readonly projectValue: T | undefined;

    /** Effective project -> global -> default value, not the chosen editor write scope. */
    readonly value: T;

    readonly source: "default" | SettingsScope;
}

/** Only declared string property names can address top-level settings. */
export type SettingsKey<TSchema extends TObject> = keyof Static<TSchema> &
    keyof TSchema["properties"] &
    string;

/**
 * A commit/reload updated state, but one or more change observers failed afterward.
 * The operation must not be retried as though persistence failed. Inspect committed
 * state and report observer errors separately; errors contains the failed listeners.
 */
export class SettingsNotificationError extends AggregateError {
    readonly code = "SETTINGS_NOTIFICATION_FAILED";
    readonly committed = true;

    constructor(errors: unknown[]) {
        super(errors, "Settings change listeners failed after state was updated");
        this.name = "SettingsNotificationError";
    }
}

/**
 * Recognize committed-state errors by protocol markers, not this copy's constructor.
 * Different installed Core copies can share a backend but have different classes.
 */
export function isSettingsNotificationError(error: unknown): error is SettingsNotificationError {
    return (
        error instanceof Error &&
        "code" in error &&
        error.code === "SETTINGS_NOTIFICATION_FAILED" &&
        "committed" in error &&
        error.committed === true
    );
}

/** Read-only snapshot shape; acquisition also deep-freezes returned snapshot data. */
export type DeepReadonly<T> = T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// Bound generic schema expansion so importing the SDK cannot exhaust TypeScript instantiation.
type ObjectPaths<T extends TObject, Depth extends unknown[] = []> = Depth["length"] extends 8
    ? never
    : {
          [K in keyof T["properties"] & string]: T["properties"][K] extends TOptional
              ? never
              :
                    | readonly [K]
                    | (T["properties"][K] extends TObject
                          ? readonly [K, ...ObjectPaths<T["properties"][K], [...Depth, unknown]>]
                          : never);
      }[keyof T["properties"] & string];

/**
 * A top-level key or required object-property tuple; array indices are not paths.
 * Compile-time tuple inference is bounded to eight object levels to limit expansion.
 */
export type SettingsPath<T extends TObject> = SettingsKey<T> | ObjectPaths<T>;
/** Preserve the value type selected by a string key or nested tuple path. */
export type SettingsPathValue<T, P> = P extends keyof T
    ? T[P]
    : P extends readonly [infer K, ...infer R]
      ? K extends keyof T
          ? R extends []
              ? T[K]
              : SettingsPathValue<T[K], R>
          : never
      : never;

/**
 * Typed capability borrowed from a live view; it retires with that view.
 * Nested edits preserve sibling properties and require backend.update transactions.
 */
export interface SettingsField<T> {
    /** Frozen normalized path; strings become one-segment paths. */
    readonly path: readonly string[];
    /** Validation schema for this path; consumers must not mutate backend metadata. */
    readonly schema: TSchema;
    /** Scopes this field can be written at: the view's scopes minus project for global-only keys. */
    readonly scopes: readonly SettingsScope[];
    /** Clone of the effective value; editing it does not write back to the backend. */
    get(): T;
    /** Child values retain the containing top-level override's source/precedence. */
    inspect(): SettingInspection<T>;
    /** Validate and persist at the requested scope (global by default). */
    set(value: T, options?: { scope?: SettingsScope }): Promise<void>;
    /** Restore this child from inheritance; remove a redundant parent override when equal. */
    reset(options?: { scope?: SettingsScope }): Promise<void>;
}

/**
 * A lease-local capability over potentially shared committed configuration.
 *
 * Returned data is isolated; no backend transaction or release method is exposed.
 * Retirement rejects further reads/writes/subscriptions and aborts signal immediately;
 * already accepted asynchronous operations may finish before the owner releases storage.
 */
export interface SettingsView<TSchema extends TObject> {
    readonly id: string;
    /** View lifetime only; combine with operation cancellation to discard late UI work. */
    readonly signal: AbortSignal;
    /**
     * Scopes this view reads and writes. Project is absent when the folder is not
     * trusted: project files are then neither read nor written.
     */
    readonly scopes: readonly SettingsScope[];
    /** Read an isolated effective value using project -> global -> default precedence. */
    get<K extends SettingsKey<TSchema>>(key: K): Static<TSchema>[K];
    /** Read isolated defaults, explicit overrides, effective value and winning source. */
    inspect<K extends SettingsKey<TSchema>>(key: K): SettingInspection<Static<TSchema>[K]>;
    /**
     * Frozen point-in-time values; global excludes project overrides, while omitted
     * scope/project returns effective values. This is not a reactive backend reference.
     */
    snapshot(options?: { scope?: SettingsScope }): DeepReadonly<Static<TSchema>>;
    /**
     * Replace one complete top-level override; omitted scope writes global.
     * Project writes reject outside `scopes` and for global-only keys.
     * A SettingsNotificationError means the write committed despite observer failure.
     */
    set<K extends SettingsKey<TSchema>>(
        key: K,
        value: Static<TSchema>[K],
        options?: { scope?: SettingsScope },
    ): Promise<void>;
    /** Remove a scope's override to resume inheritance; does not replace it with a default. */
    reset<K extends SettingsKey<TSchema>>(
        key: K,
        options?: { scope?: SettingsScope },
    ): Promise<void>;
    /** Bind a required path; nested paths throw if the backend lacks atomic update support. */
    field<const P extends SettingsPath<TSchema>>(
        path: P,
    ): SettingsField<SettingsPathValue<Static<TSchema>, P>>;
    /** Lease-owned change observation; release is idempotent and automatic on retirement. */
    subscribe(listener: () => void): () => void;
    /** Ask storage to reread external state; invalid data rejects rather than using defaults. */
    reload(): Promise<void>;
}

/**
 * Manual ownership pair from /settings/advanced; releasing never retires other leases.
 * Detach dependent UI first, then await release to drain accepted work and storage cleanup.
 */
export interface SettingsLease<TSchema extends TObject> {
    readonly settings: SettingsView<TSchema>;
    /** Abort the view synchronously; share one async result and aggregate cleanup failures. */
    release(): Promise<void>;
}
