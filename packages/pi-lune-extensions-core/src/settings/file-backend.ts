/**
 * Default JSON storage with process-local sharing and two serialization boundaries.
 *
 * Core Host indexes a namespace by its resolved global file; its project entries share
 * the declaration contract and global state but keep their own project overrides and
 * reference counts. The namespace queue serializes commits/publication/close across
 * those entries; file-store.ts separately serializes rewrites of each file.
 *
 * Loading upgrades older files through the declaration's migrations and writes the
 * result back; newer files are rejected rather than reinterpreted. Untrusted projects
 * get a global-only entry that never touches project files. A top-level override
 * replaces that whole value, not a deep merge. External changes require reload;
 * atomic rename is not cross-process locking or an automatic watcher.
 */
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { Static, TObject } from "typebox";
import { getCoreHost } from "../core/host.ts";
import {
    globalSettingsDirectory,
    projectSettingsDirectory,
    settingsFile,
    updateStoredSettings,
    type SettingsOverrides,
    type StoredSettings,
} from "./file-store.ts";
import { assertSettingsSchema, SettingsNotificationError } from "./types.ts";
import type { SettingsBackend } from "./backend.ts";
import type { SettingsKey, SettingsSchema, SettingsScope, SettingInspection } from "./types.ts";
import { freezeValue, type SettingsMigration } from "./definition.ts";

/** Everything two acquisitions must agree on before sharing one namespace. */
type Contract = { schema: TObject; version: number; globalOnly: readonly string[] };
// Reference counts belong to backend acquisitions, not borrowed Panel registrations.
type Entry = {
    backend: FileSettingsBackend<TObject>;
    ready: Promise<void>;
    references: number;
    closing?: Promise<void>;
};
type Namespace = {
    contract: Contract;
    migrations: readonly SettingsMigration[];
    entries: Map<string, Entry>;
    pending: Promise<unknown>;
};

/** Declaration data the default backend needs; paths are derived, never supplied. */
export interface FileBackendOptions<T extends TObject> {
    readonly id: string;
    readonly schema: T;
    readonly cwd: string;
    readonly projectTrusted: boolean;
    readonly migrations: readonly SettingsMigration[];
    readonly globalOnly: readonly string[];
}

// Untrusted contexts read no project file, so every untrusted cwd can share one entry.
const UNTRUSTED_ENTRY = "";

function enqueue<T>(namespace: Namespace, operation: () => Promise<T>): Promise<T> {
    const result = namespace.pending.then(operation, operation);
    // The caller retains the rejecting result; later operations are independent of its outcome.
    namespace.pending = result;
    void result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

async function resolveGlobalFile(id: string): Promise<string> {
    // Loading the SDK at acquisition time keeps declarations independent of its runtime peers.
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    return settingsFile(globalSettingsDirectory(getAgentDir()), id);
}

function namespaceFor<T extends TObject>(
    globalPath: string,
    options: Omit<FileBackendOptions<T>, "cwd" | "projectTrusted">,
): Namespace {
    const namespaces = getCoreHost().settings.namespaces as Map<string, Namespace>;
    const contract: Contract = {
        schema: options.schema,
        version: options.migrations.length + 1,
        globalOnly: [...options.globalOnly].sort(),
    };
    const existing = namespaces.get(globalPath);
    if (existing) {
        if (!isDeepStrictEqual(existing.contract, contract))
            throw new TypeError(
                `Conflicting settings declaration for "${options.id}": another extension uses a different schema, version or global-only list`,
            );
        return existing;
    }
    const namespace: Namespace = {
        contract: freezeValue(Value.Clone(contract)),
        migrations: options.migrations,
        entries: new Map(),
        pending: Promise.resolve(),
    };
    namespaces.set(globalPath, namespace);
    return namespace;
}

/**
 * Reuse/init one project backend and transfer a balanced reference to the caller.
 *
 * A live namespace rejects conflicting contracts, including from another Core copy.
 * Failed initialization releases its reference so corrected files can be retried.
 * Closing entries are awaited rather than resurrected; release is idempotent and
 * the final release queues closure behind writes already accepted by the namespace.
 * @internal Public consumers acquire through Settings leases, not backend references.
 */
export async function acquireFileBackend<T extends TObject>(
    options: FileBackendOptions<T>,
): Promise<{ backend: SettingsBackend<T>; release(): Promise<void> }> {
    assertSettingsSchema(options.schema);
    const globalPath = await resolveGlobalFile(options.id);
    const projectPath = options.projectTrusted
        ? settingsFile(projectSettingsDirectory(options.cwd), options.id)
        : undefined;
    const entryKey = projectPath ?? UNTRUSTED_ENTRY;
    const namespaces = getCoreHost().settings.namespaces as Map<string, Namespace>;
    const namespace = namespaceFor(globalPath, options);
    let entry = namespace.entries.get(entryKey);
    if (entry?.closing) {
        await entry.closing;
        return acquireFileBackend(options);
    }
    if (!entry) {
        const backend = new FileSettingsBackend(
            options.id,
            namespace.contract.schema,
            globalPath,
            projectPath,
            options.cwd,
            namespace,
        );
        entry = { backend, references: 0, ready: backend.reload() };
        namespace.entries.set(entryKey, entry);
    }
    entry.references++;
    let releaseResult: Promise<void> | undefined;
    const capturedEntry = entry;
    const release = (): Promise<void> => {
        if (releaseResult) return releaseResult;
        capturedEntry.references--;
        if (capturedEntry.references) return (releaseResult = Promise.resolve());
        capturedEntry.closing = enqueue(namespace, async () => {
            capturedEntry.backend.close();
            if (namespace.entries.get(entryKey) === capturedEntry)
                namespace.entries.delete(entryKey);
            if (!namespace.entries.size && namespaces.get(globalPath) === namespace)
                namespaces.delete(globalPath);
        });
        return (releaseResult = capturedEntry.closing);
    };
    try {
        await entry.ready;
        return { backend: entry.backend as unknown as SettingsBackend<T>, release };
    } catch (error) {
        await release();
        throw error;
    }
}

/** Version upgrade and stored-data validation for one namespace's files. */
class StoredSettingsCodec {
    private readonly id: string;
    private readonly schema: TObject;
    private readonly version: number;
    private readonly migrations: readonly SettingsMigration[];
    private readonly globalOnly: ReadonlySet<string>;

    constructor(
        id: string,
        schema: TObject,
        version: number,
        migrations: readonly SettingsMigration[],
        globalOnly: ReadonlySet<string>,
    ) {
        this.id = id;
        this.schema = schema;
        this.version = version;
        this.migrations = migrations;
        this.globalOnly = globalOnly;
    }

    // Newer data may use meanings this version cannot know; rejecting keeps it intact.
    upgrade(stored: StoredSettings, file: string): StoredSettings {
        if (stored.version > this.version)
            throw new Error(
                `${file} was written by a newer version of "${this.id}" (settings version ${stored.version}; this version supports ${this.version}). Update the extension, or remove the file to restore defaults.`,
            );
        let overrides = stored.overrides;
        // Absent overrides mean defaults at every version (empty files are removed with
        // their marker), so migrations only ever see data a user actually stored.
        if (!Object.keys(overrides).length) return { version: this.version, overrides };
        for (let version = stored.version; version < this.version; version++) {
            try {
                const next = this.migrations[version - 1]!(Value.Clone(overrides));
                if (next === null || typeof next !== "object" || Array.isArray(next))
                    throw new TypeError("Migrations must return a plain object");
                overrides = next;
            } catch (error) {
                throw new Error(
                    `Settings migration ${version} -> ${version + 1} for "${this.id}" failed on ${file}`,
                    { cause: error },
                );
            }
        }
        return { version: this.version, overrides };
    }

    validate(values: SettingsOverrides, scope: SettingsScope, file: string): void {
        for (const [key, value] of Object.entries(values)) {
            if (!Object.hasOwn(this.schema.properties, key))
                throw new TypeError(`Unknown setting "${key}" for "${this.id}" in ${file}`);
            if (scope === "project" && this.globalOnly.has(key))
                throw new TypeError(
                    `Setting "${key}" for "${this.id}" can only be stored globally; remove it from ${file}`,
                );
            if (!Value.Check(this.schema.properties[key]!, value))
                throw new TypeError(
                    `Invalid value for setting "${key}" for "${this.id}" in ${file}`,
                );
        }
    }
}

/**
 * One project's committed view; global publication updates every live project entry.
 * Validation completes before state replacement, and every affected inspection is
 * updated before listeners run so cross-project readers observe a coherent commit.
 */
class FileSettingsBackend<T extends TObject> implements SettingsBackend<T> {
    readonly id: string;
    readonly settingSchema: SettingsSchema<T>;
    private readonly globalPath: string;
    private readonly projectPath: string | undefined;
    private readonly cwd: string;
    private readonly namespace: Namespace;
    private readonly codec: StoredSettingsCodec;
    private global: SettingsOverrides = {};
    private project: SettingsOverrides = {};
    private inspections = new Map<string, SettingInspection<unknown>>();
    private readonly listeners = new Set<() => void>();
    private closed = false;

    constructor(
        id: string,
        schema: T,
        globalPath: string,
        projectPath: string | undefined,
        cwd: string,
        namespace: Namespace,
    ) {
        assertSettingsSchema(schema);
        this.id = id;
        this.globalPath = globalPath;
        this.projectPath = projectPath;
        this.cwd = cwd;
        this.namespace = namespace;
        this.settingSchema = schema;
        this.codec = new StoredSettingsCodec(
            id,
            schema,
            namespace.contract.version,
            namespace.migrations,
            new Set(namespace.contract.globalOnly),
        );
    }

    inspect<K extends SettingsKey<T>>(key: K): SettingInspection<Static<T>[K]> {
        this.assertKey(key);
        return Value.Clone(this.inspections.get(key)!) as SettingInspection<Static<T>[K]>;
    }

    subscribe(listener: () => void): () => void {
        this.assertOpen();
        const subscription = () => listener();
        this.listeners.add(subscription);
        return () => {
            this.listeners.delete(subscription);
        };
    }

    // Validate both files before publication so bad external edits keep the last good state.
    reload(): Promise<void> {
        this.assertOpen();
        return enqueue(this.namespace, () => this.refresh());
    }

    // Callers must already hold the namespace queue.
    private async refresh(): Promise<void> {
        const [global, project] = await Promise.all([
            this.load(this.globalPath, "global"),
            this.projectPath ? this.load(this.projectPath, "project") : {},
        ]);
        this.global = global;
        this.project = project;
        this.publishGlobal(global);
    }

    set<K extends SettingsKey<T>>(
        key: K,
        value: Static<T>[K],
        options?: { scope?: SettingsScope },
    ): Promise<void> {
        this.assertKey(key);
        if (!Value.Check(this.settingSchema.properties[key], value))
            return Promise.reject(new TypeError(`Invalid value for setting "${key}"`));
        const stored = Value.Clone(value);
        return this.update(key, () => stored, options);
    }

    reset<K extends SettingsKey<T>>(key: K, options?: { scope?: SettingsScope }): Promise<void> {
        return this.update(key, () => undefined, options);
    }

    /**
     * Run a complete read/transform/validate/write/publication transaction.
     * Re-read inside the file queue rather than applying a transform to cached state;
     * nested edits from different project entries must preserve the latest siblings.
     */
    update<K extends SettingsKey<T>>(
        key: K,
        transform: (value: Static<T>[K], inherited: Static<T>[K]) => Static<T>[K] | undefined,
        options?: { scope?: SettingsScope },
    ): Promise<void> {
        this.assertKey(key);
        const scope = options?.scope ?? "global";
        if (scope !== "global" && scope !== "project")
            return Promise.reject(new TypeError(`Unknown settings scope "${scope}"`));
        if (scope === "project" && !this.projectPath)
            return Promise.reject(
                new TypeError(
                    `Project settings for "${this.id}" are disabled because ${this.cwd} is not a trusted project`,
                ),
            );
        if (scope === "project" && this.namespace.contract.globalOnly.includes(key))
            return Promise.reject(
                new TypeError(`Setting "${key}" for "${this.id}" can only be stored globally`),
            );
        const file = scope === "global" ? this.globalPath : this.projectPath!;
        return enqueue(this.namespace, async () => {
            const global = await this.load(this.globalPath, "global");
            let committed: SettingsOverrides | undefined;
            await updateStoredSettings(file, (stored) => {
                const current = this.codec.upgrade(stored, file).overrides;
                this.codec.validate(current, scope, file);
                const inherited =
                    scope === "project" && Object.hasOwn(global, key)
                        ? global[key]
                        : this.settingSchema.properties[key]!.default;
                const value = Object.hasOwn(current, key) ? current[key] : inherited;
                const next = transform(
                    Value.Clone(value) as Static<T>[K],
                    Value.Clone(inherited) as Static<T>[K],
                );
                if (next === undefined) delete current[key];
                else {
                    if (!Value.Check(this.settingSchema.properties[key], next))
                        throw new TypeError(`Invalid value for setting "${key}"`);
                    // Own data properties keep "__proto__" keys from invoking prototype setters.
                    Object.defineProperty(current, key, {
                        value: Value.Clone(next),
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                }
                committed = current;
                return { version: this.namespace.contract.version, overrides: current };
            });
            if (scope === "global") this.publishGlobal(committed!);
            else {
                this.project = committed!;
                this.publishGlobal(global);
            }
        });
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.inspections.clear();
    }

    // Upgraded files are written back so later readers, including older entries, agree.
    private async load(file: string, scope: SettingsScope): Promise<SettingsOverrides> {
        const stored = await updateStoredSettings(file, (stored) => {
            const upgraded = this.codec.upgrade(stored, file);
            this.codec.validate(upgraded.overrides, scope, file);
            return upgraded;
        });
        return stored.overrides;
    }

    private assertOpen(): void {
        if (this.closed) throw new Error(`Settings backend "${this.id}" is released`);
    }
    private assertKey(key: string): void {
        this.assertOpen();
        if (!Object.hasOwn(this.settingSchema.properties, key))
            throw new TypeError(`Unknown setting "${key}"`);
    }

    private publishGlobal(global: SettingsOverrides): void {
        // Publish every affected snapshot before notifying any consumer of the shared global value.
        const changed: FileSettingsBackend<TObject>[] = [];
        for (const { backend } of this.namespace.entries.values()) {
            backend.global = global;
            if (backend.recompute()) changed.push(backend);
        }
        const errors: unknown[] = [];
        for (const backend of changed)
            for (const listener of [...backend.listeners]) {
                try {
                    listener();
                } catch (error) {
                    errors.push(error);
                }
            }
        if (errors.length) throw new SettingsNotificationError(errors);
    }

    // Undefined alone marks absence; null/falsy overrides must retain their winning scope.
    private recompute(): boolean {
        const inspections = new Map<string, SettingInspection<unknown>>();
        for (const [key, schema] of Object.entries(this.settingSchema.properties)) {
            const globalValue = Object.hasOwn(this.global, key)
                ? Value.Clone(this.global[key])
                : undefined;
            const projectValue = Object.hasOwn(this.project, key)
                ? Value.Clone(this.project[key])
                : undefined;
            inspections.set(key, {
                defaultValue: Value.Clone(schema.default),
                globalValue,
                projectValue,
                value: Value.Clone(
                    projectValue !== undefined
                        ? projectValue
                        : globalValue !== undefined
                          ? globalValue
                          : schema.default,
                ),
                source:
                    projectValue !== undefined
                        ? "project"
                        : globalValue !== undefined
                          ? "global"
                          : "default",
            });
        }
        if (isDeepStrictEqual(this.inspections, inspections)) return false;
        this.inspections = inspections;
        return true;
    }
}
