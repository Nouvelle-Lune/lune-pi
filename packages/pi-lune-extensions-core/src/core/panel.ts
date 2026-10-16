import { defineSettingsPanel } from "../panel/definition.ts";
import { coreSettings } from "./settings.ts";

export const corePanel = defineSettingsPanel(coreSettings, {
    id: "core",
    label: "Core",
});
