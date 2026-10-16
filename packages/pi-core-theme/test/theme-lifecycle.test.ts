import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
    ModelRuntime,
    keyText,
    VERSION,
    SessionManager,
    SettingsManager as PiSettingsManager,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    type CreateAgentSessionRuntimeFactory,
    type ExtensionError,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createThemeExtension } from "../src/extension.ts";
import { createSettingsFixture } from "./harness/settings.ts";

const luneTheme = createThemeExtension({ piVersion: VERSION, keyText });

test("persisted theme is reapplied by real Pi reload and session replacement", async (t) => {
    // A fresh theme factory must acquire the saved switch after the old runtime retires.
    const files = await createSettingsFixture(t);
    await files.writeScope("global", { enabled: true });
    const model = fauxProvider({
        provider: "lune-theme-lifecycle",
        models: [{ id: "fixture", contextWindow: 64000, maxTokens: 2048 }],
    });
    const modelRuntime = await ModelRuntime.create({
        authPath: join(files.agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(model.provider);
    const settingsManager = PiSettingsManager.inMemory({ retry: { enabled: false } });
    const errors: ExtensionError[] = [];
    const headers: Parameters<ExtensionUIContext["setHeader"]>[0][] = [];
    const factory: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
    }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoaderOptions: {
                extensionFactories: [luneTheme],
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
    const runtime = await createAgentSessionRuntime(factory, {
        cwd: files.cwd,
        agentDir: files.agentDir,
        sessionManager: SessionManager.inMemory(files.cwd),
    });
    t.after(() => runtime.dispose());
    const bindings = {
        mode: "tui" as const,
        uiContext: {
            setHeader: (header: Parameters<ExtensionUIContext["setHeader"]>[0]) =>
                headers.push(header),
        } as unknown as ExtensionUIContext,
        onError: (error: ExtensionError) => errors.push(error),
    };
    runtime.setRebindSession(async (session) => {
        await session.bindExtensions(bindings);
    });
    await runtime.session.bindExtensions(bindings);
    assert.equal(typeof headers.at(-1), "function");
    const initial = headers.at(-1);
    await runtime.session.reload();
    assert.deepEqual(errors, []);
    assert.equal(typeof headers.at(-1), "function");
    assert.notStrictEqual(headers.at(-1), initial);
    assert.equal(headers.at(-2), undefined);
    await runtime.newSession();
    assert.deepEqual(errors, []);
    assert.equal(typeof headers.at(-1), "function");
    assert.deepEqual(await files.readScope("global"), { enabled: true });
});
