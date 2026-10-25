import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import extension from "../../src/index.ts";
import { projectDefinitionsDir } from "../../src/paths.ts";
import { RUN_NOTIFICATION_TYPE } from "../../src/notify/notifier.ts";
import { SUBAGENT_TOOL_NAMES } from "../../src/tools/subagent-tools.ts";
import { fakeCtx, fakePi, tempAgentDir, writeDefinition } from "./support.ts";

function load(t: TestContext) {
    const agentDir = tempAgentDir(t);
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

    return { agentDir, pi, fire, beforeAgentStart };
}

test("loading registers the agents command, the notification renderer and the lifecycle handlers", (t) => {
    const { pi } = load(t);

    assert.equal(pi.commands.get("agents")?.description, "Open the subagent inspector");
    assert.equal(typeof pi.renderers.get(RUN_NOTIFICATION_TYPE), "function");
    for (const event of [
        "session_start",
        "before_agent_start",
        "session_before_tree",
        "session_tree",
        "session_shutdown",
    ]) {
        assert.equal(pi.handlers.get(event)?.length, 1, event);
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
