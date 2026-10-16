import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

type Scope = "global" | "project";

/**
 * Isolated Pi agent directory and project for tests that exercise Core's settings storage.
 *
 * Only on-disk files are touched; the code under test acquires settings through Core's public entries.
 */
export async function createSettingsFixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lune-theme-settings-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(cwd, { recursive: true });

    t.after(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    });

    const settingsPath = (scope: Scope, projectCwd = cwd) =>
        scope === "global"
            ? path.join(agentDir, "lune-settings", "pi-core-theme.json")
            : path.join(projectCwd, ".pi", "lune-settings", "pi-core-theme.json");

    const writeScope = async (scope: Scope, value: unknown, projectCwd = cwd) => {
        const target = settingsPath(scope, projectCwd);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(value), "utf-8");
    };

    const readRawScope = (scope: Scope, projectCwd = cwd) =>
        readFile(settingsPath(scope, projectCwd), "utf-8");

    const readScope = async (scope: Scope, projectCwd = cwd) =>
        JSON.parse(await readRawScope(scope, projectCwd)) as unknown;

    return { root, agentDir, cwd, settingsPath, writeScope, readRawScope, readScope };
}
