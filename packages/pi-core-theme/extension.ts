import {
    InteractiveMode,
    keyText,
    VERSION,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createThemeExtension } from "./src/extension.ts";

/** Pi transforms the source tree so reload replaces handlers and stateful helpers use its host. */
export default function luneCoreTheme(pi: ExtensionAPI) {
    return createThemeExtension({ piVersion: VERSION, keyText, interactiveMode: InteractiveMode })(
        pi,
    );
}
