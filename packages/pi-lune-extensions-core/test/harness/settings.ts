import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { Type, type TObject } from "typebox";
import { defineSettings } from "../../src/settings/index.ts";
import { acquireSettings } from "../../src/settings/advanced.ts";
import { createSettingsSandbox } from "../../src/testing/index.ts";
import {
    globalSettingsDirectory,
    projectSettingsDirectory,
    settingsFile,
} from "../../src/settings/file-store.ts";

export function createSettingsSchema() {
    return Type.Object({
        maxItems: Type.Integer({ default: 10, minimum: 0 }),
        label: Type.Union([Type.String(), Type.Null()], { default: "default" }),
        enabled: Type.Boolean({ default: true }),
        items: Type.Array(Type.String(), { default: ["initial"] }),
        appearance: Type.Object(
            {
                color: Type.String(),
                density: Type.Union([Type.Literal("compact"), Type.Literal("cozy")]),
            },
            { default: { color: "blue", density: "compact" } },
        ),
    });
}

/**
 * Sandboxed agent/project folders with direct access to per-namespace files.
 * `root` is the parent of both folders, so sibling projects can be created below it.
 */
export async function createSettingsFixture(t: TestContext) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-settings-api-" });
    const { agentDir, cwd } = sandbox;
    const root = path.dirname(agentDir);

    const leases = new Set<{ release(): Promise<void> }>();
    t.after(async () => {
        await Promise.allSettled([...leases].map((lease) => lease.release()));
        await sandbox.dispose();
    });

    const acquire = async <T extends TObject = ReturnType<typeof createSettingsSchema>>(
        id = "example",
        projectCwd = cwd,
        schema: T = createSettingsSchema() as unknown as T,
        options: { projectTrusted?: boolean } = {},
    ) => {
        const lease = await acquireSettings(defineSettings({ id, schema }), {
            cwd: projectCwd,
            projectTrusted: options.projectTrusted ?? true,
        });
        leases.add(lease);
        return lease;
    };

    const settingsPath = (scope: "global" | "project", id = "example", projectCwd = cwd) =>
        settingsFile(
            scope === "global"
                ? globalSettingsDirectory(agentDir)
                : projectSettingsDirectory(projectCwd),
            id,
        );

    const writeRawScope = async (
        scope: "global" | "project",
        contents: string,
        id = "example",
        projectCwd = cwd,
    ) => {
        const target = settingsPath(scope, id, projectCwd);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents, "utf-8");
    };

    const writeScope = async (
        scope: "global" | "project",
        value: unknown,
        id = "example",
        projectCwd = cwd,
    ) => writeRawScope(scope, JSON.stringify(value), id, projectCwd);

    const readRawScope = (scope: "global" | "project", id = "example", projectCwd = cwd) =>
        readFile(settingsPath(scope, id, projectCwd), "utf-8");

    const readScope = async (scope: "global" | "project", id = "example", projectCwd = cwd) =>
        JSON.parse(await readRawScope(scope, id, projectCwd)) as unknown;

    return {
        sandbox,
        root,
        agentDir,
        cwd,
        acquire,
        settingsPath,
        writeRawScope,
        writeScope,
        readRawScope,
        readScope,
    };
}
