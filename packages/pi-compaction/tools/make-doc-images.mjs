/** Offline examples rendered by the real settings panel and review notice. */
import { fileURLToPath } from "node:url";
import { compactionSettings, createCompactionPanel } from "../src/settings/section.ts";
import { reviewNoticeLines, reviewNoticeView } from "../src/ui/review-notice.ts";
import { makeTheme, settingsFrame, writeFrames } from "./doc-images.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const theme = makeTheme();
const report = {
    model: "example/classifier",
    pricingKnown: true,
    protectedTools: [
        { id: "write-config", reasons: ["tool-not-deletable"] },
        { id: "codemode-edit", reasons: ["nested-tool-not-deletable"] },
        { id: "recent-read", reasons: ["retained-region"] },
    ],
    candidateTools: 12,
    chunks: [
        { id: "redundant-1", toolCallId: "search-1" },
        { id: "redundant-2", toolCallId: "search-2" },
        { id: "redundant-3", toolCallId: "search-3" },
        { id: "redundant-fragment", toolCallId: "read-current" },
    ],
    chunkDecisions: [
        { chunkId: "redundant-1", probability: 0.96, action: "drop" },
        { chunkId: "redundant-2", probability: 0.93, action: "drop" },
        { chunkId: "redundant-3", probability: 0.91, action: "drop" },
        { chunkId: "redundant-fragment", probability: 0.88, action: "drop" },
    ],
    removedCalls: ["search-1", "search-2", "search-3"],
    oversizedRequests: 0,
    requests: 4,
    requestBudget: 16000,
    budgetFallbacks: [],
    usage: [],
    charsBefore: 48000,
    charsAfterTruncation: 39000,
    charsAfter: 31000,
};
const notice = reviewNoticeView({
    runId: 1,
    stage: "complete",
    reviewModel: report.model,
    candidateTools: report.candidateTools,
    protectedTools: report.protectedTools.length,
    completedBatches: report.requests,
    totalBatches: report.requests,
    jev: report,
});

writeFrames(root, [
    {
        name: "compaction-settings",
        title: "pi — choose how your next compaction runs",
        theme,
        lines: await settingsFrame({
            definition: compactionSettings,
            panel: createCompactionPanel(() => []),
            theme,
        }),
    },
    {
        name: "compaction-review",
        title: "pi — an illustrative tool-review notice",
        theme,
        // The fixture demonstrates the notice format; its reduction is not a benchmark.
        lines: reviewNoticeLines(notice, 106, theme).map((line) => ` ${line}`),
    },
]);
