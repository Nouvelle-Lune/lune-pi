import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createCompactionExtension } from "../../src/index.ts";
import { assistantText, user } from "../harness/fixtures.ts";

// The public entry point must install a working hook, and JeV is off unless a classifier is configured.
test("host: createCompactionExtension compacts with JeV disabled and no classifier registered", async (t) => {
    // The public extension factory must install a usable Pi hook without requiring Jev configuration.
    const dir = mkdtempSync(join(tmpdir(), "lune-entry-"));
    // A temporary auth path and an in-memory model store keep this run off the developer's global config.
    const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const faux = fauxProvider({
        provider: "entry-summary",
        models: [{ id: "entry-model", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 }],
    });
    runtime.registerNativeProvider(faux.provider);

    const sessionManager = SessionManager.inMemory(dir);
    sessionManager.appendMessage(user("u1".padEnd(400, "x")) as never);
    sessionManager.appendMessage(assistantText("a1".padEnd(400, "y")) as never);
    sessionManager.appendMessage(user("u2".padEnd(640, "z")) as never);
    sessionManager.appendMessage(assistantText("a2".padEnd(40, "w")) as never);

    const settingsManager = SettingsManager.inMemory({
        compaction: { keepRecentTokens: 100 },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
            createCompactionExtension(() => ({
                summaryModel: { provider: "entry-summary", id: "entry-model" },
                summaryThinkingLevel: "off",
                policy: {
                    deleteThreshold: 0.05,
                    deletableTools: ["read"],
                },
                jev: { enabled: false },
            })),
        ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: runtime,
        model: faux.getModel(),
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: [],
    });
    t.after(() => {
        session.dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    await session.bindExtensions({ mode: "print" });
    faux.setResponses([fauxAssistantMessage("## Goal\nentry summary")]);
    const result = await session.compact();
    assert.ok(result.summary.includes("entry summary"));
});
