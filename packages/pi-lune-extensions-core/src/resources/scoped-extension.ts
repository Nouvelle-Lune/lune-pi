/**
 * Adapter from a ResourceScope to one native Pi factory invocation.
 *
 * It installs exactly one hook, session_shutdown, and otherwise leaves Pi untouched:
 * business handlers, commands and errors stay native. The ExtensionAPI dependency is
 * type-only, so importing this module does not load the Pi SDK.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResourceScope } from "./resources.ts";

/**
 * Wrap an extension factory so everything it acquires follows the extension lifetime.
 *
 * The scope is disposed on session_shutdown in reverse acquisition order, so acquire
 * dependencies first (for example bindSettings before registerSettingsPanel). If
 * setup throws, everything acquired so far is disposed before the error propagates;
 * a cleanup failure is aggregated with the setup error instead of hiding it.
 *
 * @example
 * export default scopedExtension(async (pi, resources) => {
 *     const settings = resources.use(bindSettings(pi, definition));
 *     resources.use(registerSettingsPanel(panel, settings));
 *     resources.defer(pi.on("agent_start", async (_event, ctx) => { … }));
 * });
 */
export function scopedExtension(
    setup: (pi: ExtensionAPI, resources: ResourceScope) => void | Promise<void>,
): (pi: ExtensionAPI) => Promise<void> {
    return async (pi) => {
        const resources = new ResourceScope();
        try {
            resources.defer(pi.on("session_shutdown", () => resources.dispose()));
            await setup(pi, resources);
        } catch (error) {
            try {
                await resources.dispose();
            } catch (cleanupError) {
                // eslint-disable-next-line preserve-caught-error -- AggregateError.errors retains both failures.
                throw new AggregateError(
                    [error, cleanupError],
                    "Extension setup and cleanup failed",
                );
            }
            throw error;
        }
    };
}
