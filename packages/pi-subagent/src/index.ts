import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadToolCatalog } from "./catalog.ts";
import { formatDefinitionProblems, loadAllDefinitions, renderRoster } from "./definitions.ts";
import { SubagentDockContribution } from "./dock/dock-contribution.ts";
import { openSubagentInspector } from "./inspector/inspector.ts";
import { allowedModelRefs } from "./models.ts";
import { renderRunNotificationBox } from "./notify/notification-box.ts";
import { RUN_NOTIFICATION_TYPE, type RunNotificationDetails } from "./notify/notifier.ts";
import { RunManager } from "./run/run-manager.ts";
import { createSubagentTools } from "./tools/subagent-tools.ts";

export default function (pi: ExtensionAPI): void {
    let manager: RunManager | undefined;
    let roster: string | undefined;
    let unsubscribe: (() => void) | undefined;

    const open = async (ctx: ExtensionContext): Promise<void> => {
        if (ctx.mode !== "tui") {
            return;
        }

        if (!manager) {
            ctx.ui.notify("Subagents start with the session; there is none yet.", "warning");
            return;
        }

        await openSubagentInspector({ ctx, manager, onSeen: (run) => dock.acknowledge(run) });
    };
    const dock = new SubagentDockContribution(open);

    // The transcript looks the renderer up by custom type, so one registration per load is enough.
    pi.registerMessageRenderer<RunNotificationDetails>(
        RUN_NOTIFICATION_TYPE,
        renderRunNotificationBox,
    );

    pi.registerCommand("agents", {
        description: "Open the subagent inspector",
        handler: async (_args, ctx) => open(ctx),
    });

    pi.on("session_start", async (_event, ctx) => {
        const agentDir = getAgentDir();
        const { definitions, problems } = loadAllDefinitions({
            agentDir,
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });

        if (problems.length > 0) {
            ctx.ui.notify(formatDefinitionProblems(problems), "warning");
        }

        const catalog = await loadToolCatalog(ctx.cwd, agentDir);

        if (catalog.errors.length > 0) {
            ctx.ui.notify(
                `Subagent runs cannot load these built-in extensions:\n  ${catalog.errors.join("\n  ")}`,
                "error",
            );
        }

        manager = new RunManager({ pi, ctx, agentDir, definitions });
        manager.restore();

        // Built once per session: the declarations stay the same for every turn of it.
        for (const tool of createSubagentTools({
            manager,
            definitions,
            models: allowedModelRefs(ctx),
            catalog,
        })) {
            pi.registerTool(tool);
        }

        roster = renderRoster(definitions);
        dock.attach(ctx, manager);
        unsubscribe = manager.subscribe(() => dock.refresh());
    });

    pi.on("before_agent_start", (event) => {
        manager?.resumeNotifications();

        // The same text on every turn, so Pi's section diff sends no patch and the cache holds.
        if (roster) {
            event.systemPromptOptions.sections.subagents = roster;
        }
    });

    pi.on("session_before_tree", async (event, ctx) => manager?.beforeTree(event, ctx));

    pi.on("session_tree", () => {
        manager?.afterTree();
        dock.refresh();
    });

    pi.on("session_shutdown", async () => {
        const current = manager;

        manager = undefined;
        roster = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        dock.detach({ retired: true });
        await current?.shutdown();
    });
}
