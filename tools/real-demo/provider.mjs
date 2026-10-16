/** Script only the model boundary; Pi and every plugin execute their normal runtime paths. */
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const questions = [
    {
        header: "Storage",
        question: "Where should the session index live?",
        displayText: "Transcripts remain on disk. Choose how to look up sessions when resuming work.",
        options: [
            { label: "SQLite (Recommended)", description: "A local index with fast lookups.", preview: "```text\nsessions/\n  index.sqlite\n  transcript.jsonl\n```\n\nOne file beside the transcripts. No extra service." },
            { label: "Scan JSONL files", description: "Read each transcript at startup.", preview: "```text\nsessions/\n  *.jsonl  -> scan on resume\n```\n\nNo new index file; startup work grows with the session count." },
            { label: "In-memory index", description: "Build an index for the current process." },
        ],
    },
    {
        header: "Refresh",
        question: "When should the session index refresh?",
        options: [
            { label: "After each completed turn", description: "Keep the index up to date as work finishes." },
            { label: "When resuming a session", description: "Refresh only when the index is needed." },
        ],
    },
];

export default function realDemo(pi) {
    const events = process.env.LUNE_DEMO_EVENTS;
    const record = (type, details = {}) => appendFileSync(events, JSON.stringify({ type, ...details, time: Date.now() }) + "\n");
    const faux = fauxProvider({ provider: "lune-demo", models: [{ id: "local", name: "Lune demo · offline", reasoning: true, contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 140 });
    const recap = fauxProvider({ provider: "lune-demo-recap", models: [{ id: "recap", name: "Local recap", contextWindow: 128000, maxTokens: 2048 }], tokensPerSecond: 160 });
    const summary = fauxProvider({ provider: "lune-demo-summary", models: [{ id: "summary", name: "Local summary", contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 200 });
    for (const provider of [faux, recap, summary]) pi.registerProvider(provider.provider);
    let scenario;
    pi.registerCommand("demo", {
        description: "Run a reproducible, offline Lune recording scenario",
        handler: async (args, ctx) => {
            scenario = args.trim();
            if (scenario === "workspace") {
                faux.setResponses([
                    fauxAssistantMessage([
                        fauxThinking("Inspect the policy, apply bounded retries, and run the local request simulation."),
                        fauxToolCall("read", { path: "retry.mjs" }),
                    ], { stopReason: "toolUse" }),
                    fauxAssistantMessage(fauxToolCall("edit", { path: "retry.mjs", oldText: "    attempts: 1,\n    delayMs: 100,", newText: "    attempts: 3,\n    delayMs: 500," }), { stopReason: "toolUse" }),
                    fauxAssistantMessage(fauxToolCall("bash", { command: "node run.mjs" }), { stopReason: "toolUse" }),
                    fauxAssistantMessage("**Bounded retries are ready.** Three attempts, 500 ms delay. The local request simulation completed; review the diff above."),
                ]);
                pi.sendUserMessage("Add bounded retries for transient failures and run the local request simulation.");
            } else if (scenario === "questions") {
                faux.setResponses([
                    fauxAssistantMessage(fauxToolCall("ask_user_questions", { questions }), { stopReason: "toolUse" }),
                    fauxAssistantMessage("Compare the options in the panel. I will continue after you submit."),
                    fauxAssistantMessage("Selections received. I will use the chosen storage and refresh policy."),
                ]);
                pi.sendUserMessage("Help me choose a session-index design. Show the tradeoffs before we continue.");
            } else if (scenario === "shell") {
                faux.setResponses([
                    fauxAssistantMessage([
                        fauxToolCall("bash", { command: "node background.mjs index", mode: "background", label: "Index sessions", timeout: 120 }),
                        fauxToolCall("bash", { command: "node background.mjs assets", mode: "background", label: "Build preview assets", timeout: 120 }),
                    ], { stopReason: "toolUse" }),
                    fauxAssistantMessage("Both jobs are running in the background. Open the Dock or /shell to inspect their live output."),
                    fauxAssistantMessage("A background job finished. Its full output remains available in /shell."),
                    fauxAssistantMessage("Background work is complete. The session is ready for review."),
                ]);
                pi.sendUserMessage("Index the sample sessions and build the preview assets in the background.");
            } else if (scenario === "prepare-recap") {
                recap.setResponses([fauxAssistantMessage("Bounded retries are implemented and the local request simulation succeeded. Session-index choices were collected, and the background jobs finished. Review the changes before committing.")]);
                record("recap-prepared");
            } else if (scenario === "prepare-compaction") {
                summary.setResponses([fauxAssistantMessage("## Goal\nImprove transient-failure handling and explore the session-index workflow.\n\n## Progress\nThe retry policy uses three attempts and a 500 ms delay. The local request simulation succeeded. Storage choices were collected through Ask Question. Background indexing and asset jobs completed.\n\n## Next steps\nReview the retry diff and selected index policy before committing.")]);
                summary.appendResponses([fauxAssistantMessage("The retained turn starts two background jobs, records their real output, and confirms completion. The retry policy and selected session-index options remain the active review context.")]);
                record("compaction-prepared");
            } else {
                throw new Error("Unknown recording scenario: " + scenario);
            }
            record("command", { scenario });
        },
    });
    pi.on("session_start", () => record("ready"));
    pi.on("agent_end", () => record("agent-end", { scenario }));
    pi.on("tool_execution_end", (event) => record("tool-end", { name: event.toolName, error: event.isError }));
    pi.on("ui_prompt_start", (event) => record("ui-open", { kind: event.kind }));
    pi.on("ui_prompt_end", (event) => record("ui-close", { kind: event.kind }));
    pi.on("message_end", (event) => { if (event.message.role === "assistant" && event.message.stopReason === "error") record("provider-error", { error: event.message.errorMessage }); });
    pi.on("session_compact", () => record("compacted"));
    pi.on("session_compact_failed", (event) => record("compaction-failed", { message: event.errorMessage }));
}
