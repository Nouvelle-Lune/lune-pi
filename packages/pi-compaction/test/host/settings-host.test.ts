import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type SettingsSection } from "@lune_99/pi-lune-extensions-core/panel";
import { registerSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import {
    assistantMessage,
    acquireCompactionSettings,
    startSettingsHost,
    userMessage,
    withTemporaryPiEnvironment,
} from "../harness/settings-host.ts";
import { installConfiguredCompaction } from "../../src/extension.ts";

function longHistory() {
    return [
        userMessage("user goal".padEnd(500, "u")),
        assistantMessage("assistant plan".padEnd(500, "p")),
        userMessage("user follow-up".padEnd(500, "f")),
        assistantMessage("assistant result".padEnd(500, "r")),
    ];
}

function sectionProbe(id: string): SettingsSection {
    return {
        id,
        label: "Test probe",
        scopes: ["global", "project"],
        fields: [],
        subscribe: () => () => undefined,
        reload: async () => undefined,
    };
}

const liveHosts: Array<Awaited<ReturnType<typeof startSettingsHost>>> = [];

afterEach(async () => {
    const pending = liveHosts.splice(0);
    for (const host of pending) await host.dispose();
});

test("configured Pi compact uses the saved summary model and releases its Core panel on shutdown", async () => {
    // Pi clamps saved max to the selected model's supported level without changing the persisted choice.
    const host = await startSettingsHost({
        mode: "tui",
        history: longHistory(),
        savedSettings: {
            enabled: true,
            summaryModel: { provider: "lune-settings-summary", id: "selected-summary" },
            summaryThinkingLevel: "max",
        },
    });
    liveHosts.push(host);
    const selectedRequests: Array<{ id: string; reasoning: unknown }> = [];
    const recordSelectedRequest = (
        _context: unknown,
        options: { reasoning?: unknown } | undefined,
        _state: unknown,
        model: { id: string },
    ) => {
        selectedRequests.push({ id: model.id, reasoning: options?.reasoning });
        return fauxAssistantMessage("summary from selected model");
    };
    host.summary.setResponses([recordSelectedRequest, recordSelectedRequest]);

    const changesBefore = host.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "model_change");
    const mainModelBefore = host.session.model;
    const thinkingBefore = host.session.thinkingLevel;
    const ui = host.context().ui;
    assert.throws(
        () => registerSettingsSection(ui, sectionProbe("compaction")),
        /Duplicate settings section "compaction"/,
        "the plugin must register its section in the current Pi UI scope",
    );

    const result = await host.session.compact();
    assert.match(result.summary, /summary from selected model/);
    assert.ok(selectedRequests.length > 0);
    assert.ok(
        selectedRequests.every(
            (request) => request.id === "selected-summary" && request.reasoning === "high",
        ),
        "every history and split-turn request must use the configured model and thinking level",
    );
    assert.equal(host.summary.state.callCount, selectedRequests.length);
    assert.equal(host.main.state.callCount, 0);
    assert.equal(host.session.model, mainModelBefore);
    assert.equal(host.session.thinkingLevel, thinkingBefore);
    assert.deepEqual(
        host.sessionManager.getEntries().filter((entry) => entry.type === "model_change"),
        changesBefore,
    );
    assert.equal(
        (result.details as { luneCompaction: { summaryThinkingLevel: string } }).luneCompaction
            .summaryThinkingLevel,
        "high",
    );

    await host.shutdown();
    const releaseProbe = registerSettingsSection(ui, sectionProbe("compaction"));
    releaseProbe();
    const reacquired = await acquireCompactionSettings(host.environment.cwd);
    try {
        assert.equal(reacquired.settings.snapshot().summaryThinkingLevel, "max");
    } finally {
        await reacquired.release();
    }
});

test("configured Pi compact sends off to a non-reasoning model and preserves saved max", async () => {
    // A model without reasoning support must receive Pi's effective off level while the saved choice remains max.
    const host = await startSettingsHost({
        mode: "print",
        history: longHistory(),
        summaryReasoning: false,
        savedSettings: {
            enabled: true,
            summaryModel: { provider: "lune-settings-summary", id: "selected-summary" },
            summaryThinkingLevel: "max",
        },
    });
    liveHosts.push(host);
    const selectedRequests: Array<{ id: string; reasoning: unknown }> = [];
    const recordSelectedRequest = (
        _context: unknown,
        options: { reasoning?: unknown } | undefined,
        _state: unknown,
        model: { id: string },
    ) => {
        selectedRequests.push({ id: model.id, reasoning: options?.reasoning });
        return fauxAssistantMessage("summary from non-reasoning model");
    };
    host.summary.setResponses([recordSelectedRequest, recordSelectedRequest]);

    const result = await host.session.compact();

    assert.ok(selectedRequests.length > 0);
    assert.ok(
        selectedRequests.every(
            (request) => request.id === "selected-summary" && request.reasoning === undefined,
        ),
        "a non-reasoning model must receive no reasoning option",
    );
    assert.equal(
        (result.details as { luneCompaction: { summaryThinkingLevel: string } }).luneCompaction
            .summaryThinkingLevel,
        "off",
    );

    await host.shutdown();
    const reacquired = await acquireCompactionSettings(host.environment.cwd);
    try {
        assert.equal(reacquired.settings.snapshot().summaryThinkingLevel, "max");
    } finally {
        await reacquired.release();
    }
});

test("default Core settings run Lune summaries with the current session model", async () => {
    const host = await startSettingsHost({ mode: "print", history: longHistory() });
    liveHosts.push(host);
    host.main.setResponses([
        fauxAssistantMessage("native Pi checkpoint"),
        fauxAssistantMessage("native Pi prefix checkpoint"),
    ]);

    const result = await host.session.compact();

    assert.match(result.summary, /native Pi checkpoint/);
    assert.ok(host.main.state.callCount > 0, "Lune compaction must call the session model");
    assert.equal(
        host.summary.state.callCount,
        0,
        "following the session model must not call a separate summary provider",
    );
    assert.equal(host.integration.controller.getRun()?.stage, "complete");
    assert.deepEqual(host.integration.controller.getRun()?.summaryModel, {
        provider: "lune-settings-main",
        id: "main-model",
    });
    const releaseProbe = registerSettingsSection(host.context().ui, sectionProbe("compaction"));
    releaseProbe();
});

test("following uses a session model and effort changed after settings initialization", async () => {
    const host = await startSettingsHost({
        mode: "print",
        history: longHistory(),
        savedSettings: { summaryThinkingLevel: "max" },
    });
    liveHosts.push(host);
    const sessionModel = host.summary.getModel("other-summary");
    assert.ok(sessionModel);
    await host.session.setModel(sessionModel);
    host.session.setThinkingLevel("low");
    const requests: Array<{ id: string; reasoning: unknown }> = [];
    const recordRequest = (
        _context: unknown,
        options: { reasoning?: unknown } | undefined,
        _state: unknown,
        model: { id: string },
    ) => {
        requests.push({ id: model.id, reasoning: options?.reasoning });
        return fauxAssistantMessage("session-following checkpoint");
    };
    host.summary.setResponses([recordRequest, recordRequest]);

    const result = await host.session.compact();

    assert.ok(requests.length > 0);
    assert.ok(requests.every(({ id, reasoning }) => id === "other-summary" && reasoning === "low"));
    assert.equal(host.main.state.callCount, 0);
    const actual = (
        result.details as {
            luneCompaction: { summaryModel: unknown; summaryThinkingLevel: string };
        }
    ).luneCompaction;
    const expected = { provider: "lune-settings-summary", id: "other-summary" };
    assert.deepEqual(actual.summaryModel, expected);
    assert.equal(actual.summaryThinkingLevel, "low");
    assert.equal(host.session.model?.id, "other-summary");
    assert.equal(host.session.thinkingLevel, "low");
});

test("a failed section registration does not poison the next project session binding", async () => {
    // A rejected old UI binding must not prevent a valid new Core settings lease from attaching.
    await withTemporaryPiEnvironment("lune-binding-recovery-", async (environment) => {
        const nextCwd = `${environment.root}/next-project`;
        mkdirSync(nextCwd, { recursive: true });
        const nextUi = {};
        const firstUi = {};
        const blocker: SettingsSection = {
            id: "compaction",
            label: "Occupied by another section",
            scopes: ["global", "project"],
            fields: [],
            subscribe: () => () => undefined,
            reload: async () => undefined,
        };
        const releaseBlocker = registerSettingsSection(firstUi, blocker);
        const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
        const pi = {
            on(event: string, handler: (...args: unknown[]) => unknown) {
                const current = handlers.get(event) ?? [];
                current.push(handler);
                handlers.set(event, current);
                return () =>
                    handlers.set(
                        event,
                        current.filter((item) => item !== handler),
                    );
            },
            getAllTools: () => [],
        } as unknown as ExtensionAPI;
        const integration = await installConfiguredCompaction(pi);
        const emit = async (event: string, ctx: ExtensionContext): Promise<void> => {
            for (const handler of [...(handlers.get(event) ?? [])]) {
                await handler({ type: event, reason: "startup" }, ctx);
            }
        };
        const context = (cwd: string, ui: object): ExtensionContext =>
            ({
                cwd,
                mode: "tui",
                isProjectTrusted: () => true,
                ui,
                sessionManager: SessionManager.inMemory(cwd),
            }) as unknown as ExtensionContext;

        let retryError: unknown;
        let disposeError: unknown;
        try {
            await assert.rejects(
                emit("session_start", context(environment.cwd, firstUi)),
                /Duplicate settings section "compaction"/,
            );
            releaseBlocker();
            try {
                await emit("session_start", context(nextCwd, nextUi));
            } catch (error) {
                retryError = error;
            }
            if (retryError === undefined) {
                assert.throws(
                    () => registerSettingsSection(nextUi, sectionProbe("compaction")),
                    /Duplicate settings section "compaction"/,
                    "the replacement project must register its own section",
                );
                await emit("session_shutdown", context(nextCwd, nextUi));
                const releaseProbe = registerSettingsSection(nextUi, sectionProbe("compaction"));
                releaseProbe();
            }
        } finally {
            releaseBlocker();
            try {
                await integration.dispose();
            } catch (error) {
                disposeError = error;
            }
        }

        assert.equal(
            retryError,
            undefined,
            `a failed old binding blocked the next project session: ${String(retryError)}${disposeError ? `; cleanup also failed: ${String(disposeError)}` : ""}`,
        );
        assert.equal(
            disposeError,
            undefined,
            `plugin disposal failed after session retry: ${String(disposeError)}`,
        );
    });
});
