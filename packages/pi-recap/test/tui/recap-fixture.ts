import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeTerminalFocus } from "../../src/focus.ts";

export default function recapFixture(pi: ExtensionAPI): void {
    const record = (event: string) => {
        if (process.env.PI_RECAP_PROBE_PATH)
            appendFileSync(process.env.PI_RECAP_PROBE_PATH, `${event}\n`);
    };
    let notifyRequest: (() => void) | undefined;
    pi.registerProvider("offline-recap", {
        api: "offline-recap-api",
        apiKey: "offline-fixture",
        baseUrl: "http://localhost.invalid",
        models: [
            {
                id: "fixture",
                name: "Offline recap fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 64000,
                maxTokens: 2048,
            },
            {
                id: "codex/gpt-6.1-sol",
                name: "GPT-6.1-Sol · Codex",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 64000,
                maxTokens: 2048,
            },
        ],
        streamSimple: (model) => {
            record("request");
            notifyRequest?.();
            const stream = createAssistantMessageEventStream();
            const message: AssistantMessage = {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Offline recap: settings completed; verify terminal focus next. Appearance previews, section switching, and global/project scopes are ready. This offline response uses production recap rendering. Resize the terminal to verify wrapping, the path src/runtime.ts, and the moon marker. Confirm this final sentence remains visible. Window focus still needs manual verification.",
                    },
                ],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
            return stream;
        },
    });
    let releaseInput: (() => void) | undefined;
    pi.on("session_start", (_event, ctx) => {
        releaseInput?.();
        releaseInput = observeTerminalFocus(process.stdin, (focus) => record(`focus-${focus}`));
        notifyRequest = () => ctx.ui.notify("Offline provider requested", "info");
        ctx.ui.notify("Offline recap fixture ready", "info");
    });
    pi.on("ui_prompt_end", (event, ctx) => {
        if (event.kind === "custom") ctx.ui.notify("Offline settings closed", "info");
    });
    pi.on("session_shutdown", () => {
        releaseInput?.();
        releaseInput = undefined;
    });
}
