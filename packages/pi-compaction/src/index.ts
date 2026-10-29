import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CompactionController } from "./compaction-controller.ts";
import type { ConfigurationProvider } from "./options.ts";
import { createReviewNotice } from "./ui/review-notice.ts";

export type {
    CompactionController,
    CompactionRun,
    CompactionRunListener,
    CompactionRunUpdate,
    CompactionStage,
} from "./compaction-controller.ts";
export { DEFAULT_COMPACTION_POLICY } from "./options.ts";
export type {
    CompactionOptions,
    CompactionPolicy,
    ConfigurationProvider,
    JevOptions,
} from "./options.ts";
export type { ProtectedTool, ResultChunk } from "./tool-review/candidates.ts";
export type { BudgetFallback, ChunkDecision, ToolReviewReport } from "./tool-review/review.ts";

export function installCompaction(
    pi: ExtensionAPI,
    getConfiguration: ConfigurationProvider,
): CompactionController {
    return new CompactionController(pi, getConfiguration, { onRunChange: createReviewNotice(pi) });
}

/** Embedded consumers own configuration; the standalone Pi entry uses Core settings. */
export function createCompactionExtension(
    getConfiguration: ConfigurationProvider,
): ExtensionFactory {
    return (pi) => {
        installCompaction(pi, getConfiguration);
    };
}
