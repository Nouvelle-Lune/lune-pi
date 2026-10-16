import { Type } from "typebox";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { defineSettings } from "../../src/settings/index.ts";
import { acquireSettings } from "../../src/settings/advanced.ts";
import { createSettingsSection, registerSettingsSection } from "../../src/panel/host.ts";

const appearanceSchema = Type.Object({
    compact: Type.Boolean({ default: true }),
    color: Type.Union([Type.Literal("accent"), Type.Literal("success"), Type.Literal("warning")], {
        default: "accent",
    }),
    lines: Type.Integer({ default: 3, minimum: 1, maximum: 6 }),
});
const generalSchema = Type.Object({
    enabled: Type.Boolean({ default: true }),
    label: Type.String({ default: "Example" }),
});

type Appearance = {
    compact: boolean;
    color: "accent" | "success" | "warning";
    lines: number;
};
function preview(values: Appearance, theme: Theme): Component {
    return {
        render(width) {
            const marker = theme.fg(values.color, "●");
            const lines = values.compact
                ? [`${marker} Example task · 3 items · running`]
                : [
                      theme.bold(`${marker} Example task`),
                      theme.fg("muted", "Status: running · 3 items"),
                  ];
            for (let index = 0; index < values.lines; index++) {
                lines.push(theme.fg(values.color, `  ${index + 1}. Sample output line`));
            }
            return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
    };
}

export default function settingsDemo(pi: ExtensionAPI): void {
    let dispose = async (): Promise<void> => {};
    pi.on("session_start", async (_event, ctx) => {
        await dispose();
        const appearanceLease = await acquireSettings(
            defineSettings({ id: "preview-demo", schema: appearanceSchema }),
            { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() },
        );
        const generalLease = await acquireSettings(
            defineSettings({ id: "general-demo", schema: generalSchema }),
            { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() },
        );
        const appearance = appearanceLease.settings;
        const general = generalLease.settings;
        const releases = [
            registerSettingsSection(
                ctx.ui,
                createSettingsSection(appearance, {
                    label: "Appearance",
                    fields: {
                        compact: {
                            label: "Compact layout",
                            editor: "select",
                            presentation: true,
                            preview: ({ values, theme }) => preview(values, theme),
                        },
                        color: {
                            label: "Status color",
                            editor: "select",
                            presentation: true,
                            preview: ({ values, theme }) => preview(values, theme),
                        },
                        lines: {
                            label: "Preview lines",
                            description: "Between 1 and 6 lines.",
                            presentation: true,
                            preview: ({ values, theme }) => preview(values, theme),
                        },
                    },
                }),
            ),
            registerSettingsSection(ctx.ui, createSettingsSection(general, { label: "General" })),
        ];
        ctx.ui.notify("Settings demo ready. Run /lune-core-settings.", "info");
        dispose = async () => {
            for (const release of releases) release();
            await appearanceLease.release();
            await generalLease.release();
        };
    });
    pi.on("session_shutdown", () => dispose());
}
