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
                `cannot be mentioned. Larger values retain more sessions and take longer to load.`,
            inMenu: "mention",
            formatValue: (value) => `${value} MB`,
        }),
        field(["mention", "textLimit"], {
            label: "Session text limit",
            description:
                "Characters kept from each session's first message and searchable text. " +
                "Use a positive integer; a change applies at the next load of the session list.",
            inMenu: "mention",
            formatValue: (value) => `${value} characters`,
        }),
    ],
    menus: [
        {
            id: "mention",
            label: "Mention",
            description: "Settings for @ and @@ session mentions.",
            summary: ({ values }) =>
                `cache ${values.mention.cacheSizeMB} MB · text ${values.mention.textLimit} chars`,
        },
    ],
});
