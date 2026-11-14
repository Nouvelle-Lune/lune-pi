import { defineSettingsPanel } from "../panel/definition.ts";
import { coreSettings, MENTION_CACHE_MAX_MB, MENTION_CACHE_MIN_MB } from "./settings.ts";

export const corePanel = defineSettingsPanel(coreSettings, {
    id: "core",
    label: "Core",
    fields: (field) => [
        field(["mention", "cacheSizeMB"], {
            label: "Session cache size",
            description:
                `The index on disk behind the @ and @@ session lists, ${MENTION_CACHE_MIN_MB} to ` +
                `${MENTION_CACHE_MAX_MB} MB. Sessions older than what fits are not listed and ` +
                `cannot be mentioned. Each MB adds about 4 ms to every load and save of the list.`,
            inMenu: "mention",
            formatValue: (value) => `${value} MB`,
        }),
    ],
    menus: [
        {
            id: "mention",
            label: "Mention",
            description: "Settings for @ and @@ session mentions.",
            summary: ({ values }) => `cache ${values.mention.cacheSizeMB} MB`,
        },
    ],
});
