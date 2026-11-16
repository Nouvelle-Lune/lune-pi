import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { SessionRow } from "../../src/core/types.ts";
import { eventHeading, renderTranscript } from "../../src/ingest/transcripts.ts";
import { Store } from "../../src/store/db.ts";
import { listEvents } from "../../src/store/rows.ts";
import { createMemoryEnv, seedSession, type SeedEvent } from "../harness/memory.ts";

let store: Store;
beforeEach(() => {
    store = Store.open(":memory:");
});
afterEach(() => store.close());

function render(
    events: SeedEvent[],
    session: Partial<SessionRow> = {},
): { text: string; lines: Map<string, number>; rows: ReturnType<typeof listEvents> } {
    const base = seedSession(store, { id: "s1", events });
    const rows = listEvents(store, "pi", "s1");
    return { ...renderTranscript({ ...base, ...session }, rows), rows };
}

/** The heading line that the transcript has at the reported 1-based line of each event. */
function headingsAtReportedLines(
    result: ReturnType<typeof render>,
): Array<{ expected: string; actual: string | undefined }> {
    const rendered = result.text.split("\n");
    return result.rows.map((event) => ({
        expected: eventHeading(event),
        actual: rendered[(result.lines.get(event.key) ?? 0) - 1],
    }));
}

describe("renderTranscript line numbers", () => {
    it("points each event to its heading line", () => {
        const result = render([
            { role: "user", text: "first" },
            { role: "assistant", text: "second" },
        ]);

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
    });

    it("counts the lines of multi-line event text before the next event", () => {
        const result = render([
            { role: "user", text: "line one\nline two\n\nline four" },
            { role: "assistant", text: "a\nb" },
            { role: "user", text: "last" },
        ]);

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
    });

    it("counts the extra lines of a text that contains a code fence", () => {
        const result = render([
            { role: "user", text: "before\n```js\ncode\n```\nafter" },
            { role: "assistant", text: "next" },
        ]);

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
    });

    it("counts marker lines for untrusted, memory-derived and inactive events", () => {
        const result = render([
            { role: "tool_result", text: "out", untrusted: true },
            { role: "assistant", text: "from memory", memoryDerived: true },
            { role: "user", text: "abandoned", active: false },
            { role: "user", text: "plain" },
        ]);

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
        assert.match(result.text, /^Markers: untrusted$/mu);
        assert.match(result.text, /^Markers: inactive$/mu);
    });

    it("does not let a multi-line title or warning shift the lines after the header", () => {
        const result = render([{ role: "user", text: "one" }], {
            title: "A title\nwith a second line",
            warnings: ["warn one\nwith more text", "warn two"],
        });

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
        const header = result.text.split("\n").slice(0, 3);
        assert.equal(header[0], "# A title with a second line");
        assert.ok(result.text.includes("  - warn one with more text"));
    });

    it("keeps the lines right for an event with an empty text", () => {
        const result = render([
            { role: "user", text: "" },
            { role: "user", text: "after empty" },
        ]);

        for (const { expected, actual } of headingsAtReportedLines(result)) {
            assert.equal(actual, expected);
        }
    });
});

describe("transcript_line after an import", () => {
    it("stores the heading line of each event in the written transcript file", async () => {
        const env = await createMemoryEnv();
        try {
            const repo = env.folder("app");
            env.writePiSession({
                id: "sa",
                cwd: repo,
                messages: [
                    { role: "user", text: "Question\nwith two lines" },
                    { role: "assistant", text: "Answer\n\nwith a gap\nand more" },
                    { role: "user", text: "Follow-up" },
                ],
            });
            env.importNow();

            const rows = listEvents(env.store, "pi", "sa");
            const [session] = env.store.all("SELECT transcript_path FROM sessions WHERE id = 'sa'");
            const path = String(session?.transcript_path);
            const file = readFileSync(path, "utf8").split("\n");

            assert.ok(rows.length >= 3);
            for (const event of rows) {
                assert.ok(event.transcriptLine);
                assert.equal(file[event.transcriptLine - 1], eventHeading(event));
            }
        } finally {
            env.cleanup();
        }
    });
});
