import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindSettings } from "@lune_99/pi-lune-extensions-core/settings";
import { registerSettingsPanel } from "@lune_99/pi-lune-extensions-core/panel";
import { ResourceScope } from "@lune_99/pi-lune-extensions-core/resources";
import { CompactionController } from "./compaction-controller.ts";
import { resolveCompactionSettings } from "./settings/schema.ts";
import { compactionSettings, createCompactionPanel } from "./settings/section.ts";

export async function installConfiguredCompaction(pi: ExtensionAPI) {
    const resources = new ResourceScope();
    resources.defer(pi.on("session_shutdown", () => resources.dispose()));
    try {
        const settings = resources.use(bindSettings(pi, compactionSettings));
        resources.use(
            registerSettingsPanel(
                createCompactionPanel(() => pi.getAllTools()),
                settings,
            ),
        );
        const controller = resources.use(
            new CompactionController(pi, async (ctx) => {
                const view = await settings.view(ctx);
                return resolveCompactionSettings(view.snapshot(), ctx);
            }),
        );
        return { controller, dispose: () => resources.dispose() };
    } catch (error) {
        try {
            await resources.dispose();
        } catch (cleanupError) {
            // eslint-disable-next-line preserve-caught-error -- AggregateError.errors retains both failures.
            throw new AggregateError([error, cleanupError], "Compaction setup and cleanup failed");
        }
        throw error;
    }
}

export default async function luneCompaction(pi: ExtensionAPI): Promise<void> {
    await installConfiguredCompaction(pi);
}
