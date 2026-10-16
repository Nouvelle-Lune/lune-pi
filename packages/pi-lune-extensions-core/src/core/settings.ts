import { Type } from "typebox";
import { defineSettings } from "../settings/definition.ts";

// Reserve Core's namespace without introducing settings solely for the placeholder.
export const coreSettings = defineSettings({
    id: "pi-lune-extensions-core",
    schema: Type.Object({}),
});
