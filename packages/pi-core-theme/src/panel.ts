import { defineSettingsPanel } from "@lune_99/pi-lune-extensions-core";
import { createLuneHeader, type HeaderOptions } from "./header.ts";
import { themeSettings } from "./settings.ts";
import { createPalette } from "./palette.ts";
import { paletteNames, palettes } from "./palettes/index.ts";
import { renderEditDiffResult } from "./renderer/tool/diff/diff-edit-render.ts";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config/config.ts";
import { CallList } from "./ui/call-list.ts";
import { Disclosure } from "./ui/disclosure.ts";
import { renderToolLine } from "./renderer/tool/presentation.ts";

const sampleDiff =
    "  1 export function greet(name: string) {\n- 2   return 'Hi ' + name;\n+ 2   return `Hello, ${name}!`;\n  3 }";
const diffPreview = ({ values, theme }: { values: Config; theme: Theme }): Component =>
    renderEditDiffResult(
        { diff: sampleDiff, firstChangedLine: 2 },
        { expanded: true, filePath: "src/greet.ts" },
        values,
        theme,
        "",
    );

export function createThemePanel(header: HeaderOptions) {
    return defineSettingsPanel(themeSettings, {
        id: "core-theme",
        label: "Theme",
        fields: (field) => [
            field("enabled", {
                label: "Core theme",
                description:
                    "Enable the Lune header, palettes, tool cards and other appearance options.",
                preview: ({ value, theme }) =>
                    value
                        ? createLuneHeader(theme, header)
                        : {
                              render: (width) => [
                                  truncateToWidth(
                                      theme.fg("muted", "Pi's built-in appearance"),
                                      width,
                                  ),
                              ],
                              invalidate() {},
                          },
            }),
            field("mode", {
                label: "Style · Tool display",
                description:
                    "On shows individual cards and groups; compact summarizes tool rounds; off restores native Pi rendering. Requires Core theme to be enabled.",
                choices: [
                    { value: "on", label: "on", description: "Lune cards and rich diffs" },
                    { value: "compact", label: "compact", description: "Collapsed tool rounds" },
                    { value: "off", label: "off", description: "Native Pi tools" },
                ],
                preview: ({ value, theme }) => ({
                    invalidate() {},
                    render: (width) =>
                        value === "compact"
                            ? [
                                  new CallList().renderHeader(
                                      theme,
                                      width,
                                      "tools",
                                      ["done", "done", "done"],
                                      false,
                                      false,
                                      " ",
                                  ),
                              ]
                            : value === "off"
                              ? [
                                    theme.bg(
                                        "toolSuccessBg",
                                        theme.fg("toolTitle", "read src/greet.ts"),
                                    ),
                                    theme.fg(
                                        "toolOutput",
                                        "export function greet(name: string) { … }",
                                    ),
                                ].map((line) => truncateToWidth(line, width, ""))
                              : [
                                    new Disclosure().render(
                                        theme,
                                        width,
                                        0,
                                        false,
                                        ` ${renderToolLine(theme, width, {
                                            name: "read",
                                            summary: "src/greet.ts",
                                            status: "done",
                                            durationMs: 8,
                                            detail: "12 lines",
                                        })}`,
                                    ),
                                ],
                }),
            }),
            field("palette", {
                label: "Style · Color palette",
                description:
                    "Lune palettes tint the crescent, transcript and code. Inherit keeps the active Pi theme; disabling Core restores the preceding palette.",
                choices: [
                    { value: "inherit", label: "Inherit Pi theme" },
                    ...paletteNames.map((value) => ({
                        value,
                        label: palettes[value].label,
                        description: palettes[value].description,
                    })),
                ],
                preview: ({ value, theme }) =>
                    createLuneHeader(
                        value === "inherit" ? theme : createPalette(value, theme),
                        header,
                    ),
            }),
            field("paletteBackground", {
                label: "Style · Palette background",
                description:
                    "Paint the terminal background and default text with the palette's own colors, so dark and light palettes look right on any terminal profile. Off keeps the terminal's colors, as the Plain palettes always do.",
            }),
            field("excludeRenderers", {
                label: "Style · Native tools",
                description:
                    "Tool names to leave with their original renderer. Self-framed extension tools retain their own interactions automatically.",
                editor: "json",
            }),
            field("toolLabelClip", {
                label: "Style · Summary width",
                description: "Maximum summary columns; 0 uses the available terminal width.",
            }),
            field("diffViewMode", {
                label: "Diff · Layout",
                description:
                    "Auto selects split on wide terminals and unified on narrow terminals.",
                preview: diffPreview,
            }),
            field("diffIndicatorMode", {
                label: "Diff · Indicators",
                description: "Choose subtle color bars, classic plus/minus markers, or no markers.",
                preview: diffPreview,
            }),
            field("diffSplitMinWidth", {
                label: "Diff · Split threshold",
                description: "Minimum terminal width for automatic side-by-side diffs.",
                preview: diffPreview,
            }),
            field("editDiffCollapsedLines", {
                label: "Diff · Edit preview",
                description: "Visible edit diff lines while collapsed; 0 keeps only change counts.",
                preview: diffPreview,
            }),
            field("writeDiffCollapsedLines", {
                label: "Diff · Write preview",
                description:
                    "Visible write diff lines while collapsed; 0 keeps the creation or overwrite summary.",
                preview: diffPreview,
            }),
            field("diffWordWrap", {
                label: "Diff · Wrap lines",
                description: "Wrap long changed lines instead of clipping them.",
                preview: diffPreview,
            }),
            field("expandedInputMaxLines", {
                label: "UI · Input preview",
                description: "Maximum input lines rendered inside an expanded card.",
            }),
            field("expandedOutputMaxLines", {
                label: "UI · Output preview",
                description: "Maximum output lines rendered inside an expanded card.",
            }),
            field("expandedPreviewMaxLines", {
                label: "UI · Preview budget",
                description:
                    "Maximum expanded diff lines; call lists always reveal every call when expanded.",
            }),
            field("expandedCardBackground", {
                label: "UI · Expanded surface",
                description: "Semantic palette surface for expanded cards.",
            }),
            field("previewLines", {
                label: "UI · Group preview",
                description:
                    "Collapsed call summaries (up to five calls); 0 hides calls. Thinking keeps at least one live preview line.",
            }),
            field("animationIntervalMs", {
                label: "UI · Activity refresh",
                description:
                    "Tool activity interval, with a 300ms minimum. Thinking has an independent 30fps clock; idle views run no timer.",
            }),
            field("fullscreenMouse", {
                label: "UI · Mouse interactions",
                description:
                    "Hints open detail; click any expanded panel to close it. Hidden-output rows open the full-output browser. Drag selection and navigation remain native.",
            }),
            field("showStartupHeader", {
                label: "UI · Lune header",
                description: "Show the existing Lune crescent logo and keyboard hints.",
                preview: ({ theme }) => createLuneHeader(theme, header),
            }),
        ],
    });
}
