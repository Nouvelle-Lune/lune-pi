/** Use the host's own passive style previews, which already use its production renderer. */
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { dockPanel } from "../src/dock-panel.ts";
import { dockSchema } from "../src/dock-settings.ts";
import { makeTheme, writeFrames } from "./doc-images.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const theme = makeTheme();
const values = Value.Default(dockSchema, {});
const styleField = dockPanel.fields.find((field) => field.path === "style");

function preview(style, width = 126) {
    const component = styleField.preview({ value: style, values: { ...values, style }, theme, scope: "global" });
    return component.render(width);
}

writeFrames(root, [
    { name: "dock-overview", title: "pi — select a module, press Enter, get back to work", theme, lines: preview("ruled") },
    {
        name: "dock-styles",
        title: "pi — five styles, the same tools at your fingertips",
        theme,
        lines: ["ruled", "boxed", "compact", "minimal", "classic"].flatMap((style, index) => [
            ...(index ? [""] : []),
            theme.bold(theme.fg("accent", ` ${style}`)),
            ...preview(style),
        ]),
    },
]);
