/** Offline examples rendered by the real settings panel and tool-review formatter. */
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import { compactionSettings, createCompactionPanel } from "../src/settings/section.ts";
import { formatReviewNotice } from "../src/tool-review/review.ts";
import { makeTheme, settingsFrame, writeFrames } from "./doc-images.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const theme = makeTheme();
const report = {
    model: "example/classifier",
    pricingKnown: true,
    protectedTools: [],
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
    charsAfter: 31000,
};

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
        lines: new Text(theme.fg("dim", formatReviewNotice(report)), 1, 0).render(108),
    },
]);
