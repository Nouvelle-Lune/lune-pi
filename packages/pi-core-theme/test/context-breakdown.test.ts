import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemMessage, type Tool } from "@earendil-works/pi-ai";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectContextBreakdown } from "../src/feature/context.ts";

function part(breakdown: ReturnType<typeof collectContextBreakdown>, label: string): number {
    return breakdown.parts.find((entry) => entry.label === label)!.tokens;
}

function assertPiEstimate(sessionManager: SessionManager) {
    const messages = sessionManager.buildSessionProjection().messages;
    const system = getCurrentSystemMessage(messages);
    const expected =
        (system ? estimateTokens(system) : 0) +
        messages
            .filter((message) => message.role !== "system")
            .reduce((sum, message) => sum + estimateTokens(message), 0);
    const result = collectContextBreakdown({ sessionManager });
    assert.equal(
        result.parts.reduce((sum, entry) => sum + entry.tokens, 0),
        expected,
    );
    return result;
}

test("replaced and removed system sections use Pi's current state instead of summing history", () => {
    // The reported regression counted both the 4,000-character old section and its 400-character replacement.
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
        role: "system",
        content: "",
        timestamp: 0,
        sections: {
            project_context: "x".repeat(4000),
            skills: "obsolete-skill",
            obsolete: "removed-instructions",
        },
    });
    sessionManager.appendMessage({
        role: "system",
        content: "",
        timestamp: 1,
        sections: { project_context: "y".repeat(400), skills: null, obsolete: null },
    });
    const result = assertPiEstimate(sessionManager);
    assert.equal(part(result, "Memory"), 100);
    assert.equal(part(result, "Skills"), 0);
    assert.equal(part(result, "System prompt"), 0);
    assert.equal(result.previews.memoryFiles, "y".repeat(400));
    assert.doesNotMatch(
        Object.values(result.previews).join("\n"),
        /obsolete-skill|removed-instructions|xxxx/,
    );
});

test("category allocation preserves Pi's whole-prompt rounding at section boundaries", () => {
    // Independent per-section ceilings would invent tokens when several short sections share one token.
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
        role: "system",
        content: "a",
        timestamp: 0,
        sections: { project_context: "b", skills: "c", runtime: "d" },
    });
    sessionManager.appendMessage({ role: "system", content: "extra", timestamp: 1 });
    const result = assertPiEstimate(sessionManager);
    assert.equal(
        result.parts.reduce((sum, entry) => sum + entry.tokens, 0),
        3,
    );
    assert.ok(result.parts.every((entry) => entry.tokens >= 0));
    assert.match(result.previews.systemPrompt, /a\n\nextra/);
    assert.match(result.previews.systemPrompt, /d/);
    assert.equal(result.previews.memoryFiles, "b");
    assert.equal(result.previews.skills, "c");
});

test("tool replacements and removals retain the complete Pi declaration including constrained sampling", () => {
    // Reconstructing name/description/parameters alone loses provider sampling configuration.
    const sessionManager = SessionManager.inMemory();
    const tool: Tool = {
        name: "read",
        description: "current-definition",
        parameters: Type.Object({ path: Type.String() }),
        constrainedSampling: { type: "json_schema", strict: "require" },
    };
    sessionManager.appendMessage({
        role: "system",
        content: "base",
        timestamp: 0,
        toolsAdded: [
            { ...tool, description: "superseded-definition", constrainedSampling: false },
            { ...tool, name: "removed-tool" },
        ],
    });
    sessionManager.appendMessage({
        role: "system",
        content: "",
        timestamp: 1,
        toolsRemoved: [{ name: "removed-tool" }],
        toolsAdded: [tool],
    });
    const result = assertPiEstimate(sessionManager);
    const system = getCurrentSystemMessage(sessionManager.buildSessionProjection().messages)!;
    assert.equal(
        part(result, "Tool definitions"),
        estimateTokens(system) - estimateTokens({ ...system, toolsAdded: undefined }),
    );
    assert.match(result.previews.tools, /current-definition/);
    assert.match(result.previews.tools, /"constrainedSampling"/);
    assert.match(result.previews.tools, /"strict": "require"/);
    assert.doesNotMatch(result.previews.tools, /removed-tool|superseded-definition/);
});

test("conversation and tool-result estimates use Pi's image, thinking, tool-call and custom-message rules", () => {
    // Pi's image allowance and message-specific accounting must survive without local character heuristics.
    const sessionManager = SessionManager.inMemory();
    const image = { type: "image" as const, mimeType: "image/png", data: "private-image-payload" };
    sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "user" }, image],
        timestamp: 0,
    });
    sessionManager.appendMessage({
        role: "assistant",
        timestamp: 1,
        api: "openai-responses",
        provider: "openai",
        model: "test",
        content: [
            { type: "text", text: "text" },
            { type: "thinking", thinking: "thinking" },
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } },
        ],
        stopReason: "toolUse",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    });
    sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "12345678" }, image],
        timestamp: 2,
    });
    sessionManager.appendMessage({
        role: "bashExecution",
        command: "pwd",
        output: "/workspace",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 3,
    });
    sessionManager.appendCustomMessageEntry("context-note", "note", false);
    const result = assertPiEstimate(sessionManager);
    assert.equal(part(result, "Tool results"), 1202);
    assert.equal(part(result, "Messages"), 1214);
    assert.match(result.previews.contextFiles, /Assistant thinking[\s\S]*thinking/);
    assert.match(result.previews.contextFiles, /Assistant tool call: read[\s\S]*"path": "file"/);
    assert.match(result.previews.contextFiles, /Bash[\s\S]*pwd[\s\S]*\/workspace/);
    assert.match(result.previews.contextFiles, /custom[\s\S]*note/);
    assert.match(result.previews.toolResults, /image payload omitted/);
    assert.doesNotMatch(Object.values(result.previews).join("\n"), /private-image-payload/);
});

test("context edits affect both category estimates and previews through the real Pi projection", () => {
    // Raw history remains append-only, but omitted and replaced content is no longer model context.
    const sessionManager = SessionManager.inMemory();
    const omitted = sessionManager.appendMessage({
        role: "user",
        content: "discarded-context".repeat(100),
        timestamp: 0,
    });
    const replaced = sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "discarded-output".repeat(100) }],
        timestamp: 1,
    });
    sessionManager.appendContextEdit(omitted, null);
    sessionManager.appendContextEdit(replaced, { content: [{ type: "text", text: "kept" }] });
    const result = assertPiEstimate(sessionManager);
    assert.equal(part(result, "Messages"), 0);
    assert.equal(part(result, "Tool results"), 1);
    assert.match(result.previews.toolResults, /kept/);
    assert.doesNotMatch(Object.values(result.previews).join("\n"), /discarded/);
});

test("compaction uses Pi's retained system state, summary and kept messages", () => {
    // Replaying raw history would reintroduce the conversation that compaction removed.
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
        role: "system",
        content: "base",
        sections: { project_context: "memo" },
        timestamp: 0,
    });
    sessionManager.appendMessage({
        role: "user",
        content: "compacted-away".repeat(100),
        timestamp: 1,
    });
    const kept = sessionManager.appendMessage({
        role: "user",
        content: "kept-message",
        timestamp: 2,
    });
    sessionManager.appendCompaction("compaction-summary", kept, 1000);
    const result = assertPiEstimate(sessionManager);
    assert.equal(part(result, "Memory"), 1);
    assert.match(result.previews.contextFiles, /compactionSummary[\s\S]*compaction-summary/);
    assert.match(result.previews.contextFiles, /kept-message/);
    assert.doesNotMatch(result.previews.contextFiles, /compacted-away/);
});

test("a projection without system state has empty prompt categories instead of reconstructed local state", () => {
    // The current Pi projection is authoritative even before a prompt has entered the session.
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "only-user", timestamp: 0 });
    const result = assertPiEstimate(sessionManager);
    for (const label of ["System prompt", "Memory", "Skills", "Tool definitions"])
        assert.equal(part(result, label), 0);
    assert.match(result.previews.systemPrompt, /No system prompt/);
    assert.match(result.previews.tools, /No active tool definitions/);
    assert.match(result.previews.contextFiles, /only-user/);
});
