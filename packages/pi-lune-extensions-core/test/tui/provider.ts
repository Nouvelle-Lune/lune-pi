import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function demoProvider(pi: ExtensionAPI): void {
    pi.registerProvider("offline-demo", {
        api: "offline-demo-api",
        apiKey: "offline-fixture",
        baseUrl: "http://localhost.invalid",
        models: [
            {
                id: "fixture",
                name: "Offline settings fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 64000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            const message: AssistantMessage = {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Offline settings demo. Run /lune-core-settings to explore the panel.",
                    },
                ],
                api: model.api,
                provider: model.provider,
                model: model.id,
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            };
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
            return stream;
        },
    });
}
