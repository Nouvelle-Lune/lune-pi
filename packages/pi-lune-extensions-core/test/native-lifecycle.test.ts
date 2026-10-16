import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    ModelRuntime,
    SessionManager,
    SettingsManager as PiSettingsManager,
    type CreateAgentSessionRuntimeFactory,
    type ExtensionError,
    type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { bindSettings, defineSettings } from "../src/settings/index.ts";
import {
    defineSettingsPanel,
    registerSettingsPanel,
    type SettingsSection,
} from "../src/panel/index.ts";
import { getSettingsPanelRegistry } from "../src/panel/host.ts";
import { ResourceScope } from "../src/resources/index.ts";

async function temporaryEnvironment(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "lune-runtime-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    });
    return { root, agentDir, cwd };
}

test("native Settings and Panel bindings follow real Pi reload, new, fork and resume", async (t) => {
    // The actual host must retire old consumer resources without a second extension framework.
    const { cwd, agentDir, root } = await temporaryEnvironment(t);
    const sessionDir = join(root, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const model = fauxProvider({
        provider: "lune-runtime-lifecycle",
        models: [{ id: "session-model", contextWindow: 128_000, maxTokens: 8_192 }],
    });
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(model.provider);
    const piSettings = PiSettingsManager.inMemory({
        compaction: { keepRecentTokens: 100 },
        retry: { enabled: false },
    });
    const startReasons: string[] = [];
    const releasedReasons: string[] = [];
    const extensionErrors: ExtensionError[] = [];
    const mountedPanels: {
        scope: object;
        section: SettingsSection;
        signal: AbortSignal;
    }[] = [];
    let withCurrentSession: (() => Promise<{ reason: string; sessionId: string }>) | undefined;
    const definition = defineSettings({
        id: "native-real-lifecycle",
        schema: Type.Object({ enabled: Type.Boolean({ default: true }) }),
    });
    const panel = defineSettingsPanel(definition, { label: "Lifecycle" });
    const extensionFactory: ExtensionFactory = (pi) => {
        const resources = new ResourceScope();
        resources.defer(pi.on("session_shutdown", () => resources.dispose()));
        const binding = resources.use(bindSettings(pi, definition));
        resources.use(registerSettingsPanel(panel, binding));
        resources.defer(
            pi.on("session_start", async (event, ctx) => {
                const view = await binding.view(ctx);
                const sections = getSettingsPanelRegistry().getSections(ctx.ui);
                assert.equal(sections.length, 1);
                const section = sections[0]!;
                for (const previous of mountedPanels) {
                    assert.equal(previous.signal.aborted, true);
                    assert.equal(
                        getSettingsPanelRegistry()
                            .getSections(previous.scope)
                            .includes(previous.section),
                        false,
                    );
                }
                mountedPanels.push({ scope: ctx.ui, section, signal: view.signal });
                startReasons.push(event.reason);
                const reason = event.reason;
                resources.defer(() => {
                    releasedReasons.push(reason);
                });
                withCurrentSession = async () => {
                    assert.deepEqual(extensionErrors, []);
                    await binding.view(ctx);
                    view.signal.throwIfAborted();
                    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), [section]);
                    assert.equal(section.fields[0]!.inspect().value, view.get("enabled"));
                    return { reason, sessionId: ctx.sessionManager.getSessionId() };
                };
            }),
        );
    };
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        sessionManager,
        sessionStartEvent,
    }) => {
        const services = await createAgentSessionServices({
            cwd: runtimeCwd,
            agentDir: runtimeAgentDir,
            modelRuntime,
            settingsManager: piSettings,
            resourceLoaderOptions: {
                extensionFactories: [extensionFactory],
                noContextFiles: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
            },
        });
        return {
            ...(await createAgentSessionFromServices({
                services,
                sessionManager,
                sessionStartEvent,
                model: model.getModel(),
                tools: [],
            })),
            services,
            diagnostics: services.diagnostics,
        };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager: SessionManager.create(cwd, sessionDir),
    });
    const bindings = {
        mode: "tui" as const,
        uiContext: { notify: () => undefined } as never,
        onError: (error: ExtensionError) => extensionErrors.push(error),
    };
    runtime.setRebindSession(async (session) => {
        await session.bindExtensions(bindings);
    });
    await runtime.session.bindExtensions(bindings);
    t.after(() => runtime.dispose());

    const initialSessionId = runtime.session.sessionManager.getSessionId();
    const originalSessionFile = runtime.session.sessionManager.getSessionFile();
    assert.ok(initialSessionId);
    assert.ok(originalSessionFile);
    assert.deepEqual(await withCurrentSession!(), {
        reason: "startup",
        sessionId: initialSessionId,
    });

    // /resume only reopens saved sessions, so the initial file must exist before switching back to it.
    runtime.session.sessionManager.appendMessage({
        role: "user",
        content: "Persist the initial session before resuming it",
        timestamp: Date.now(),
    });
    assert.ok(existsSync(originalSessionFile));

    await runtime.session.reload();
    assert.deepEqual(await withCurrentSession!(), {
        reason: "reload",
        sessionId: initialSessionId,
    });
    assert.deepEqual(releasedReasons, ["startup"]);

    await runtime.newSession();
    const newSessionId = runtime.session.sessionManager.getSessionId();
    assert.notEqual(newSessionId, initialSessionId);
    assert.deepEqual(await withCurrentSession!(), { reason: "new", sessionId: newSessionId });
    runtime.session.sessionManager.appendMessage({
        role: "user",
        content: "Create a persistent branch for the lifecycle test",
        timestamp: Date.now(),
    });
    const forkEntryId = runtime.session.sessionManager.getLeafId();
    assert.ok(forkEntryId);

    await runtime.fork(forkEntryId, { position: "at" });
    const forkSessionId = runtime.session.sessionManager.getSessionId();
    assert.notEqual(forkSessionId, newSessionId);
    assert.deepEqual(await withCurrentSession!(), { reason: "fork", sessionId: forkSessionId });

    await runtime.switchSession(originalSessionFile);
    assert.equal(runtime.session.sessionManager.getSessionId(), initialSessionId);
    assert.deepEqual(await withCurrentSession!(), {
        reason: "resume",
        sessionId: initialSessionId,
    });
    assert.deepEqual(startReasons, ["startup", "reload", "new", "fork", "resume"]);
    assert.deepEqual(releasedReasons, ["startup", "reload", "new", "fork"]);

    await runtime.dispose();
    assert.deepEqual(extensionErrors, []);
    assert.deepEqual(releasedReasons, ["startup", "reload", "new", "fork", "resume"]);
    for (const mounted of mountedPanels) {
        assert.equal(mounted.signal.aborted, true);
        assert.deepEqual(getSettingsPanelRegistry().getSections(mounted.scope), []);
    }
});
