import { Type } from "typebox";
import { INDEX_BUDGET_MB } from "../mention/budget.ts";
import { defineSettings } from "../settings/definition.ts";

/** Bounds of the session index size a user can choose, in megabytes. */
export const MENTION_CACHE_MIN_MB = 1;
export const MENTION_CACHE_MAX_MB = 64;

export const coreSettings = defineSettings({
    id: "pi-lune-extensions-core",
    schema: Type.Object({
        mention: Type.Object(
            {
                cacheSizeMB: Type.Integer({
                    minimum: MENTION_CACHE_MIN_MB,
                    maximum: MENTION_CACHE_MAX_MB,
                    default: INDEX_BUDGET_MB,
                }),
            },
            { additionalProperties: false, default: { cacheSizeMB: INDEX_BUDGET_MB } },
        ),
    }),
    // Every Pi process shares one index file. Projects with different sizes would make each
    // process trim what the other read, so the file is read again on every load.
    globalOnly: ["mention"],
});
