import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { Harness } from "../../src/core/types.ts";
import { text as column } from "../../src/store/db.ts";
import { getSession, listEvents } from "../../src/store/rows.ts";
import {
    claudeRecord,
    createIngestEnv,
    jsonl,
    piHeader,
    piMessage,
    writeText,
    type IngestEnv,
} from "../harness/ingest.ts";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

/** Events of a session as comparable rows. */
function eventRows(env: IngestEnv, harness: Harness, sessionId: string): unknown[][] {
    return listEvents(env.store, harness, sessionId).map((event) => [
        event.key,
        event.role,
        event.text,
        event.untrusted,
    ]);
}

/** Store one active item that cites the event with this text. */
function citeEvent(env: IngestEnv, harness: Harness, sessionId: string, text: string): void {
    const source = listEvents(env.store, harness, sessionId).find((event) => event.text === text);
    assert.ok(source, `no event with text ${text}`);
    env.store.run(
        `INSERT INTO items(id, scope, kind, title, body, trust, status, origin, content_hash,
            created_at, updated_at)
        VALUES ('i1', 'global', 'preference', 'Style', 'Keep this preference.', 'user', 'active',
            'dreaming', 'h', 't', 't')`,
    );
    env.store.run(
        `INSERT INTO item_sources(item_id, seq, ref_kind, harness, session_id, event_key)
        VALUES ('i1', 0, 'event', ?, ?, ?)`,
        harness,
        sessionId,
        source.key,
    );
}

function itemStatus(env: IngestEnv): string {
    const row = env.store.get("SELECT status FROM items WHERE id = 'i1'");
    return row ? column(row, "status") : "";
}

/**
 * A changed file with unknown critical content must fail its import and keep the earlier events
 * and the item that cites them. `bad` is the complete rewritten file.
 */
function expectFailedImportKeepsEvidence(options: {
    env: IngestEnv;
    harness: Harness;
    sessionId: string;
    path: string;
    good: unknown[];
    bad: unknown[];
    citedText: string;
}): void {
    const { env, harness, sessionId, path } = options;
    writeText(path, jsonl(options.good));
    env.importer.importAll();
    const before = eventRows(env, harness, sessionId);
    assert.ok(before.some(([, , text]) => text === options.citedText));
    citeEvent(env, harness, sessionId, options.citedText);
    assert.equal(itemStatus(env), "active");

    writeText(path, jsonl(options.bad));
    const summary = env.importer.importAll();

    assert.equal(summary.errors, 1);
    assert.match(summary.problems[0]?.error ?? "", /^Unknown format: line \d+: /u);
    const after = eventRows(env, harness, sessionId);
    assert.deepEqual(after, before);
    assert.equal(itemStatus(env), "active");
    assert.equal(getSession(env.store, harness, sessionId)?.status, "error");
}

describe("a changed file with unknown critical content", () => {
    let env: IngestEnv;
    afterEach(() => env.cleanup());

    it("Pi: fails the import and keeps the evidence when a user block is an unknown text block", () => {
        env = createIngestEnv({ now: NOW });
        const path = join(env.roots.pi, "cwd-a", "s1.jsonl");
        const good = [
            piHeader("s1", env.cwd),
            piMessage("m1", null, "user", [{ type: "text", text: "Keep this evidence" }]),
        ];

        expectFailedImportKeepsEvidence({
            env,
            harness: "pi",
            sessionId: "s1",
            path,
            good,
            bad: [
                ...good,
                piMessage("m2", "m1", "user", [{ type: "rich_text", text: "Keep this evidence" }]),
            ],
            citedText: "Keep this evidence",
        });
    });

    it("Pi: fails the import and keeps the evidence when tool result content is an object", () => {
        env = createIngestEnv({ now: NOW });
        const path = join(env.roots.pi, "cwd-a", "s2.jsonl");
        const head = [
            piHeader("s2", env.cwd),
            piMessage("m1", null, "user", "look"),
            piMessage("m2", "m1", "assistant", [
                { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
            ]),
        ];
        const toolResult = (content: unknown) => ({
            type: "message",
            id: "m3",
            parentId: "m2",
            timestamp: "2026-01-01T00:00:02.000Z",
            message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content },
        });

        expectFailedImportKeepsEvidence({
            env,
            harness: "pi",
            sessionId: "s2",
            path,
            good: [...head, toolResult([{ type: "text", text: "Tool evidence" }])],
            bad: [...head, toolResult({ value: "Tool evidence" })],
            citedText: "Tool evidence",
        });
    });

    it("Claude: fails the import and keeps the evidence when tool result content is an object", () => {
        env = createIngestEnv({ now: NOW });
        const path = join(env.roots.claude, "proj", "s3.jsonl");
        const head = [
            claudeRecord("s3", "u1", null, "user", "Read a result"),
            claudeRecord("s3", "a2", "u1", "assistant", [
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ]),
        ];
        const toolResult = (content: unknown) =>
            claudeRecord("s3", "u3", "a2", "user", [
                { type: "tool_result", tool_use_id: "t1", content },
            ]);

        expectFailedImportKeepsEvidence({
            env,
            harness: "claude",
            sessionId: "s3",
            path,
            good: [...head, toolResult("Keep this tool evidence")],
            bad: [...head, toolResult({ value: "Keep this tool evidence" })],
            citedText: "Keep this tool evidence",
        });
    });
});
