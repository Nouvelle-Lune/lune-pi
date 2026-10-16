/** Drives the real contributor tools with a local faux provider for the dock TUI demo. */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SHELL_COMMAND = "printf 'Lune dock demo shell is running'; sleep 60";
const QUESTIONS = [
    {
        header: "Storage",
        question: "Which storage option should this demo choose?",
        options: [
            { label: "Postgres", description: "Use the server database" },
            { label: "SQLite", description: "Use a local file" },
        ],
    },
];

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);
    faux.setResponses([
        fauxAssistantMessage(
            [
                fauxToolCall("bash", { command: SHELL_COMMAND, mode: "background" }),
                fauxToolCall("ask_user_questions", { questions: QUESTIONS }),
            ],
            { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("The Lune dock demo is ready for keyboard navigation."),
    ]);
}
