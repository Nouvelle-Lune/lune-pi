import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ShellDockContribution } from "./shell/shell-dock-contribution.ts";

import { ShellManager } from "./shell/shell-manager.ts";

import { BashTool, BackgroundShellTool, KillBackgroundShellTool } from "./tools/bash-tool.ts";
import {
    BACKGROUND_SHELL_NOTIFICATION_TYPE,
    registerBackgroundShellNotifications,
    type BackgroundShellNotificationDetails,
} from "./shell/shell-notification.ts";
import { renderBackgroundShellNotificationBox } from "./shell/shell-notification-box.ts";

export default function (pi: ExtensionAPI): void {
    installShellInspector(pi);
}

/**
 * Register the extension on `pi` and return the shell manager of this load.
 *
 * The manager belongs to the load, not to the module: Pi reuses a loaded module for the sessions it
 * starts in the same working directory, subagent runs included, and each of them owns its jobs.
 */
export function installShellInspector(pi: ExtensionAPI): ShellManager {
    const shellManager = new ShellManager();
    const dock = new ShellDockContribution(shellManager);

    // Registered once per load: the transcript looks the renderer up by custom type when it draws
    // the message, so a session-scoped registration would only re-register the same function.
    pi.registerMessageRenderer<BackgroundShellNotificationDetails>(
        BACKGROUND_SHELL_NOTIFICATION_TYPE,
        renderBackgroundShellNotificationBox,
    );

    let unsubscribeShellManager: (() => void) | undefined;

    let unsubscribeBackgroundShellNotifications: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
        // Release the old context before manager resets can notify its subscribers.
        unsubscribeShellManager?.();
        unsubscribeShellManager = undefined;
        dock.detach({ retired: true });
        // Restore the shell manager state from the session context.
        shellManager.restoreShellManager(ctx);

        dock.attach(ctx);

        unsubscribeShellManager = shellManager.subscribe((event) => {
            dock.onManagerEvent(event);
        });

        unsubscribeBackgroundShellNotifications?.();

        // Register background shell notifications
        unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(
            pi,
            shellManager,
            ctx,
        );
    });

    pi.on("session_shutdown", () => {
        // Unsubscribe before clearing: clearAllJobs() emits, and a live
        // listener would re-render the dock after it was removed.
        unsubscribeShellManager?.();
        unsubscribeShellManager = undefined;
        dock.detach();
        unsubscribeBackgroundShellNotifications?.();
        unsubscribeBackgroundShellNotifications = undefined;
        shellManager.clearAllJobs(pi);
    });

    pi.on("session_before_tree", (_event, ctx) => {
        unsubscribeBackgroundShellNotifications?.();
        unsubscribeBackgroundShellNotifications = undefined;
        try {
            shellManager.clearAllJobs(pi);
        } finally {
            unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(
                pi,
                shellManager,
                ctx,
            );
        }
    });

    pi.on("session_tree", (_event, ctx) => {
        shellManager.clearAllJobs();
        shellManager.restoreShellManager(ctx);
        dock.render();
    });

    // Register tools
    // The background tools only read the jobs of this load's shell manager, so they ship with the
    // wrapper that starts them; a separate extension could not see them.
    pi.registerTool(BashTool(shellManager));
    pi.registerTool(BackgroundShellTool(shellManager));
    pi.registerTool(KillBackgroundShellTool(shellManager));

    // Register commands
    pi.registerCommand("shell", {
        description: "Open the shell inspector",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                return;
            }
            await dock.open(ctx);
        },
    });

    return shellManager;
}
