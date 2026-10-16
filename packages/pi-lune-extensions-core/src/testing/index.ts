/**
 * Test-only helpers for extensions built on Core; never import this from production code.
 *
 * A sandbox points Pi's agent directory at a temporary folder through the
 * PI_CODING_AGENT_DIR variable and provides a project folder, so tests exercise the
 * real default storage without touching personal settings. The variable is process
 * global: only one sandbox may be active per process, and Node's test runner already
 * isolates test files in separate processes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TObject } from "typebox";
import { acquireSettings } from "../settings/acquire.ts";
import { defineSettings, type SettingsDefinition } from "../settings/definition.ts";
import {
    globalSettingsDirectory,
    projectSettingsDirectory,
    settingsFile,
} from "../settings/file-store.ts";
import type { SettingsLease, SettingsScope } from "../settings/types.ts";

const AGENT_DIR = "PI_CODING_AGENT_DIR";
let active: SettingsSandbox | undefined;

/** Temporary agent and project folders with direct access to stored settings files. */
export interface SettingsSandbox {
    /** Temporary Pi agent directory, exported as PI_CODING_AGENT_DIR while active. */
    readonly agentDir: string;
    /** Temporary project directory to pass as cwd. */
    readonly cwd: string;
    /** Absolute path of a definition's file for one scope. */
    settingsFile(definition: SettingsDefinition<TObject>, scope: SettingsScope): string;
    /**
     * Write a scope's raw file, bypassing validation, to stage existing or broken data.
     * Objects are serialized as JSON; strings are written exactly as given.
     */
    writeStored(
        definition: SettingsDefinition<TObject>,
        scope: SettingsScope,
        contents: Record<string, unknown> | string,
    ): Promise<void>;
    /** Parse a scope's raw file, or return undefined when it does not exist. */
    readStored(
        definition: SettingsDefinition<TObject>,
        scope: SettingsScope,
    ): Promise<Record<string, unknown> | undefined>;
    /** Acquire a lease (trusted project by default) that dispose() releases. */
    acquire<T extends TObject>(
        definition: SettingsDefinition<T>,
        options?: { projectTrusted?: boolean },
    ): Promise<SettingsLease<T>>;
    /** Release sandbox leases, restore PI_CODING_AGENT_DIR and delete the folders. */
    dispose(): Promise<void>;
}

/**
 * Create the process's single active settings sandbox.
 * @throws Error When another sandbox has not been disposed yet.
 */
export async function createSettingsSandbox(
    options: { prefix?: string } = {},
): Promise<SettingsSandbox> {
    if (active) throw new Error("Another settings sandbox is still active; dispose it first");
    const root = await mkdtemp(path.join(os.tmpdir(), options.prefix ?? "lune-settings-test-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const previous = process.env[AGENT_DIR];
    process.env[AGENT_DIR] = agentDir;
    const leases = new Set<SettingsLease<TObject>>();
    let disposal: Promise<void> | undefined;
    const fileFor = (definition: SettingsDefinition<TObject>, scope: SettingsScope) => {
        const { id } = defineSettings(definition);
        return settingsFile(
            scope === "global" ? globalSettingsDirectory(agentDir) : projectSettingsDirectory(cwd),
            id,
        );
    };
    const sandbox: SettingsSandbox = {
        agentDir,
        cwd,
        settingsFile: fileFor,
        async writeStored(definition, scope, contents) {
            const file = fileFor(definition, scope);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(
                file,
                typeof contents === "string" ? contents : JSON.stringify(contents, null, 4),
                "utf-8",
            );
        },
        async readStored(definition, scope) {
            try {
                return JSON.parse(await readFile(fileFor(definition, scope), "utf-8"));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        },
        async acquire(definition, options = {}) {
            const lease = await acquireSettings(definition, {
                cwd,
                projectTrusted: options.projectTrusted ?? true,
            });
            leases.add(lease as unknown as SettingsLease<TObject>);
            return lease;
        },
        dispose() {
            disposal ??= (async () => {
                const results = await Promise.allSettled(
                    [...leases].map((lease) => lease.release()),
                );
                if (previous === undefined) delete process.env[AGENT_DIR];
                else process.env[AGENT_DIR] = previous;
                if (active === sandbox) active = undefined;
                await rm(root, { recursive: true, force: true });
                const errors = results.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                );
                if (errors.length)
                    throw new AggregateError(errors, "Settings sandbox cleanup failed");
            })();
            return disposal;
        },
    };
    active = sandbox;
    return sandbox;
}
