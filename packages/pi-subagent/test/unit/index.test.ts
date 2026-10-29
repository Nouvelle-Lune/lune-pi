import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

import extension from "../../src/index.ts";
import { projectDefinitionsDir } from "../../src/paths.ts";
import { RUN_NOTIFICATION_TYPE } from "../../src/notify/notifier.ts";
import { subagentSettings } from "../../src/settings/schema.ts";
import { SUBAGENT_TOOL_NAMES } from "../../src/tools/subagent-tools.ts";
import { fakeCtx, fakePi, tempAgentDir, toolInfo, writeDefinition } from "./support.ts";

function load(t: TestContext, agentDir = tempAgentDir(t)) {
    const pi = fakePi();

    extension(pi.api);

    const fire = async (
        event: string,
        payload: unknown,
        ctx: ReturnType<typeof fakeCtx>["ctx"],
    ) => {
        for (const handler of pi.handlers.get(event) ?? []) {
            await handler(payload, ctx);
        }
    };
    const beforeAgentStart = async (ctx: ReturnType<typeof fakeCtx>["ctx"]) => {
        const event = { systemPromptOptions: { sections: {} as Record<string, string> } };

        await fire("before_agent_start", event, ctx);

        return event.systemPromptOptions.sections;
    };

    return { agentDir, pi, fire, beforeAgentStart, reload: () => load(t, agentDir) };
}

test("loading registers the agents command, the notification renderer and the lifecycle handlers", (t) => {
    const { pi } = load(t);

    assert.equal(pi.commands.get("agents")?.description, "Open the subagent inspector");
    assert.equal(typeof pi.renderers.get(RUN_NOTIFICATION_TYPE), "function");
    for (const event of ["before_agent_start", "session_before_tree", "session_tree"]) {
        assert.equal(pi.handlers.get(event)?.length, 1, event);
    }

    // Core's settings binding adds its own session_start and session_shutdown handler.
    for (const event of ["session_start", "session_shutdown"]) {
        assert.equal(pi.handlers.get(event)?.length, 2, event);
    }

    // Tools depend on the session's definitions and models, so they wait for session_start.
    assert.equal(pi.tools.size, 0);
});

test("session_start registers the four tools with the loaded definitions in the agent enum", async (t) => {
    const { agentDir, pi, fire } = load(t);
    const { ctx } = fakeCtx();

    writeDefinition(agentDir, "reviewer.md", "---\nname: reviewer\ndescription: Reviews.\n---\n");
    await fire("session_start", { reason: "startup" }, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    assert.deepEqual([...pi.tools.keys()], [...SUBAGENT_TOOL_NAMES]);

    const start = pi.tools.get("subagent_start") as unknown as {
        parameters: { properties: { agent: { enum: string[] } } };
    };

    assert.deepEqual(start.parameters.properties.agent.enum, ["reviewer"]);
});

const AGENTS_CHANNEL = "lune-subagent:agents-loaded";

test("session_start publishes the sorted loaded names and leaves out unusable definitions", async (t) => {
    const { agentDir, pi, fire } = load(t);
    const cwd = projectCwd(t);
    const { ctx } = fakeCtx({ cwd, projectTrusted: false });
    const published: unknown[] = [];
    pi.events.on(AGENTS_CHANNEL, (names) => published.push(names));

    writeDefinition(agentDir, "b.md", "---\nname: beta\ndescription: Second.\n---\n");
    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");
    writeDefinition(agentDir, "bad.md", "---\nname: bad\n---\n");
    writeProjectDefinition(cwd, "reviewer", "Reviews diffs.");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    const expected = [["alpha", "beta"]];
    assert.deepEqual(published, expected);
});

test("shutdown publishes an empty list and a reloaded extension publishes the next session's names", async (t) => {
    const first = load(t);
    const { ctx } = fakeCtx();
    const published: unknown[] = [];

    first.pi.events.on(AGENTS_CHANNEL, (names) => published.push(names));
    writeDefinition(first.agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");

    await first.fire("session_start", {}, ctx);
    await first.fire("session_shutdown", {}, ctx);

    // Pi builds a new extension runtime after /reload; a disposed settings binding cannot restart.
    const reloaded = first.reload();

    reloaded.pi.events.on(AGENTS_CHANNEL, (names) => published.push(names));
    writeDefinition(first.agentDir, "b.md", "---\nname: beta\ndescription: Second.\n---\n");
    await reloaded.fire("session_start", {}, ctx);
    t.after(() => reloaded.fire("session_shutdown", {}, ctx));

    const expected = [["alpha"], [], ["alpha", "beta"]];
    assert.deepEqual(published, expected);
    assert.deepEqual([...reloaded.pi.tools.keys()], [...SUBAGENT_TOOL_NAMES]);
});

test("before_agent_start writes the roster into the subagents section", async (t) => {
    const { agentDir, fire, beforeAgentStart } = load(t);
    const { ctx } = fakeCtx();

    writeDefinition(agentDir, "b.md", "---\nname: beta\ndescription: Second.\n---\n");
    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    const first = await beforeAgentStart(ctx);
    const second = await beforeAgentStart(ctx);

    assert.equal(first["subagents"], "- alpha: First.\n- beta: Second.");
    assert.equal(second["subagents"], first["subagents"]);
});

test("without definitions the system prompt gets no subagents section", async (t) => {
    const { fire, beforeAgentStart } = load(t);
    const { ctx } = fakeCtx();

    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    assert.deepEqual(await beforeAgentStart(ctx), {});
});

test("an invalid definition is reported with a warning and left out of the roster", async (t) => {
    const { agentDir, fire, beforeAgentStart } = load(t);
    const { ctx, ui } = fakeCtx();

    writeDefinition(agentDir, "bad.md", "---\nname: bad\n---\n");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    assert.equal(ui.notifications.length, 1);
    assert.equal(ui.notifications[0]!.type, "warning");
    assert.match(ui.notifications[0]!.message, /not loaded \(1\)[\s\S]*bad\.md/);
    assert.deepEqual(await beforeAgentStart(ctx), {});
});

test("session_shutdown drops the roster until the next session_start", async (t) => {
    const { agentDir, fire, beforeAgentStart } = load(t);
    const { ctx } = fakeCtx();

    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");
    await fire("session_start", {}, ctx);
    await fire("session_shutdown", {}, ctx);

    assert.deepEqual(await beforeAgentStart(ctx), {});
});

test("tree events and shutdown before any session_start do nothing and do not throw", async (t) => {
    const { fire } = load(t);
    const { ctx } = fakeCtx();

    await fire("session_before_tree", { preparation: {} }, ctx);
    await fire("session_tree", {}, ctx);
    await fire("session_shutdown", {}, ctx);
});

test("/agents says there is no session yet in the TUI and does nothing elsewhere", async (t) => {
    const { pi } = load(t);
    const tui = fakeCtx({ mode: "tui" });
    const print = fakeCtx({ mode: "print" });
    const handler = pi.commands.get("agents")!.handler;

    await handler("", tui.ctx);
    await handler("", print.ctx);

    assert.equal(tui.ui.notifications.length, 1);
    assert.equal(tui.ui.notifications[0]!.type, "warning");
    assert.equal(print.ui.notifications.length, 0);
});

function projectCwd(t: TestContext): string {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-project-"));

    t.after(() => rmSync(cwd, { recursive: true, force: true }));

    return cwd;
}

function writeProjectDefinition(cwd: string, name: string, description: string): void {
    const dir = projectDefinitionsDir(cwd);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
    );
}

test("in a trusted project, its definitions reach the agent enum and the marked roster", async (t) => {
    const { agentDir, pi, fire, beforeAgentStart } = load(t);
    const cwd = projectCwd(t);
    const { ctx } = fakeCtx({ cwd, projectTrusted: true });

    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");
    writeProjectDefinition(cwd, "reviewer", "Reviews diffs.");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    const start = pi.tools.get("subagent_start") as unknown as {
        parameters: { properties: { agent: { enum: string[] } } };
    };

    assert.deepEqual(start.parameters.properties.agent.enum, ["alpha", "reviewer"]);
    assert.equal(
        (await beforeAgentStart(ctx))["subagents"],
        "- alpha: First.\n- reviewer (project): Reviews diffs.",
    );
});

test("in an untrusted project, its definitions are left out silently", async (t) => {
    const { agentDir, pi, fire, beforeAgentStart } = load(t);
    const cwd = projectCwd(t);
    const { ctx, ui } = fakeCtx({ cwd, projectTrusted: false });

    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: First.\n---\n");
    writeProjectDefinition(cwd, "reviewer", "Reviews diffs.");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    const start = pi.tools.get("subagent_start") as unknown as {
        parameters: { properties: { agent: { enum: string[] } } };
    };

    assert.deepEqual(start.parameters.properties.agent.enum, ["alpha"]);
    assert.equal((await beforeAgentStart(ctx))["subagents"], "- alpha: First.");
    assert.deepEqual(ui.notifications, []);
});

test("a project definition that replaces a user one is announced in the definitions warning", async (t) => {
    const { agentDir, fire } = load(t);
    const cwd = projectCwd(t);
    const { ctx, ui } = fakeCtx({ cwd });

    writeDefinition(agentDir, "r.md", "---\nname: reviewer\ndescription: User.\n---\n");
    writeProjectDefinition(cwd, "reviewer", "Project.");
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    assert.equal(ui.notifications.length, 1);
    assert.equal(ui.notifications[0]!.type, "warning");
    assert.match(ui.notifications[0]!.message, /not loaded \(1\)[\s\S]*replaces it/);
});

test("the tools parameter of subagent_start lists the parent's extension tools, not the excluded ones", async (t) => {
    const { pi, fire } = load(t);
    const { ctx } = fakeCtx();

    pi.allTools = [toolInfo("ext_tool"), toolInfo("hidden_tool", { exposure: "hidden" })];
    await fire("session_start", {}, ctx);
    t.after(() => fire("session_shutdown", {}, ctx));

    const start = pi.tools.get("subagent_start") as unknown as {
        parameters: { properties: { tools: { description: string } } };
    };
    const description = start.parameters.properties.tools.description;

    assert.match(description, /^- ext_tool: The ext_tool tool\.$/m);
    assert.ok(!description.includes("hidden_tool"));
});

const FAUX_FIRST = { provider: "faux", id: "faux-1" };
const FAUX_SECOND = { provider: "faux", id: "faux-2" };

function fakeModels(ids: readonly string[]) {
    return ids.map((id) => ({ provider: "faux", id, name: id }));
}

function modelsCtx(options: {
    cwd: string;
    scoped: readonly string[];
    available?: readonly string[];
}): ExtensionContext {
    const { ctx } = fakeCtx({ cwd: options.cwd });

    return {
        ...ctx,
        scopedModels: fakeModels(options.scoped).map((model) => ({ model })),
        modelRegistry: {
            getAvailable: () => fakeModels(options.available ?? options.scoped),
        },
    } as unknown as ExtensionContext;
}

async function startWithSettings(
    t: TestContext,
    options: {
        stored?: Record<string, unknown>;
        scoped?: readonly string[];
        available?: readonly string[];
    } = {},
) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-subagent-tool-models-" });

    if (options.stored) {
        await sandbox.writeStored(subagentSettings, "global", options.stored);
    }

    const lease = await sandbox.acquire(subagentSettings);
    const loaded = load(t, sandbox.agentDir);
    const ctx = modelsCtx({
        cwd: sandbox.cwd,
        scoped: options.scoped ?? [],
        ...(options.available ? { available: options.available } : {}),
    });

    t.after(async () => {
        await loaded.fire("session_shutdown", {}, ctx);
        await lease.release();
        await sandbox.dispose();
    });

    await loaded.fire("session_start", {}, ctx);

    return { ...loaded, sandbox, lease, ctx };
}

function modelEnums(pi: ReturnType<typeof fakePi>): {
    top: readonly string[] | undefined;
    batch: readonly string[] | undefined;
} {
    const start = pi.tools.get("subagent_start") as unknown as {
        parameters: {
            properties: {
                model?: { enum: string[] };
                tasks: { items: { properties: { model?: { enum: string[] } } } };
            };
        };
    };
    const properties = start.parameters.properties;

    return {
        top: properties.model?.enum,
        batch: properties.tasks.items.properties.model?.enum,
    };
}

test("session_start builds the model parameter from the saved allowed-model selection", async (t) => {
    const { pi } = await startWithSettings(t, {
        stored: { allowedModels: [FAUX_SECOND] },
        scoped: ["faux-1"],
        available: ["faux-1", "faux-2"],
    });

    const actual = modelEnums(pi);
    const expected = {
        top: ["auto", "faux/faux-2"],
        batch: ["auto", "faux/faux-2"],
    };

    assert.deepEqual(actual, expected);
});

test("changing the allowed-model selection updates both model enums, and clearing it follows Pi's scope again", async (t) => {
    const { pi, lease } = await startWithSettings(t, {
        stored: { allowedModels: [FAUX_SECOND] },
        scoped: ["faux-1", "faux-2"],
    });

    await lease.settings.set("allowedModels", [FAUX_FIRST], { scope: "global" });

    const selected = modelEnums(pi);

    assert.deepEqual(selected, {
        top: ["auto", "faux/faux-1"],
        batch: ["auto", "faux/faux-1"],
    });

    await lease.settings.set("allowedModels", [], { scope: "global" });

    const cleared = modelEnums(pi);

    assert.deepEqual(cleared, {
        top: ["auto", "faux/faux-1", "faux/faux-2"],
        batch: ["auto", "faux/faux-1", "faux/faux-2"],
    });
});

test("toggling Auto mode only re-registers subagent_start without and with model, and other settings keep it", async (t) => {
    const { pi, lease } = await startWithSettings(t, { scoped: ["faux-1"] });
    const first = pi.tools.get("subagent_start");

    assert.deepEqual(modelEnums(pi), {
        top: ["auto", "faux/faux-1"],
        batch: ["auto", "faux/faux-1"],
    });

    await lease.settings.set("autoOnly", true, { scope: "global" });

    const on = pi.tools.get("subagent_start");

    assert.notEqual(on, first);
    assert.deepEqual(modelEnums(pi), { top: undefined, batch: undefined });

    await lease.settings.set("autoClassifier", FAUX_FIRST, { scope: "global" });

    assert.equal(pi.tools.get("subagent_start"), on);

    await lease.settings.set("autoOnly", false, { scope: "global" });

    assert.notEqual(pi.tools.get("subagent_start"), on);
    assert.deepEqual(modelEnums(pi), {
        top: ["auto", "faux/faux-1"],
        batch: ["auto", "faux/faux-1"],
    });
});
