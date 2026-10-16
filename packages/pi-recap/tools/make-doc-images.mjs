/** Mount the real recap widget as Pi does; all text is an offline example. */
import { fileURLToPath } from "node:url";
import { Container, Text } from "@earendil-works/pi-tui";
import { showRecap } from "../src/runtime.ts";
import { recapSettings } from "../src/settings.ts";
import { recapPanel } from "../src/panel.ts";
import { makeTheme, settingsFrame, writeFrames } from "./doc-images.mjs";

const theme = makeTheme();
const root = fileURLToPath(new URL("../", import.meta.url));
const text =
    "The retry policy is implemented and the focused tests pass. The full suite still needs to run before the release is ready.";

function widgetFrame(width) {
    let component;
    showRecap(
        {
            ui: {
                setWidget: (_id, factory) => {
                    component = factory({}, theme);
                },
            },
        },
        text,
    );
    const mounted = new Container();
    // Pi gives below-editor widgets one column of horizontal padding.
    for (const line of component.render(width - 2)) mounted.addChild(new Text(line, 1, 0));
    return mounted.render(width);
}

writeFrames(root, [
    {
        name: "recap-widget",
        title: "pi — pick up where you left off",
        theme,
        lines: widgetFrame(104),
    },
    {
        name: "recap-settings",
        title: "pi — a recap on demand, or when you return",
        theme,
        lines: await settingsFrame({ definition: recapSettings, panel: recapPanel, theme }),
    },
]);
