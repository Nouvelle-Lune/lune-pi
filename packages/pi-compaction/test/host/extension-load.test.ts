import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    DefaultResourceLoader,
    SettingsManager as PiSettingsManager,
} from "@earendil-works/pi-coding-agent";
import { withTemporaryPiEnvironment } from "../harness/settings-host.ts";

test("Pi's public resource loader imports the extension entry and registers compaction hooks", async () => {
    // Loading through Pi's Jiti path catches SDK alias failures that native test imports bypass.
    await withTemporaryPiEnvironment("lune-extension-load-", async ({ cwd, agentDir }) => {
        const extensionPath = fileURLToPath(new URL("../../src/extension.ts", import.meta.url));
        const resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager: PiSettingsManager.inMemory({}),
            additionalExtensionPaths: [extensionPath],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
        });

        await resourceLoader.reload();

        const loaded = resourceLoader.getExtensions();
        assert.deepEqual(
            loaded.errors,
            [],
            `Pi must load the extension without module errors: ${JSON.stringify(loaded.errors)}`,
        );
        assert.equal(loaded.extensions.length, 1);
        const extension = loaded.extensions[0]!;
        for (const hook of ["session_start", "session_before_compact", "session_shutdown"]) {
            assert.ok(
                extension.handlers.get(hook)?.length,
                `expected the ${hook} hook to register`,
            );
        }
    });
});
