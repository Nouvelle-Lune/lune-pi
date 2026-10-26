import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import type { ExtensionTool } from "../../src/extension-tools.ts";
import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import {
    createFixture,
    liveSessionOf,
    reportResponse,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

/** Registers `ext_tool` (returns the cwd it runs in) and `other_tool`, plus `extra` source. */
function writeExtension(fx: Fixture, extra = "", name = "ext.js"): string {
    const file = join(fx.root, name);
    const tool = (toolName: string, text: string) => `
    pi.registerTool({
        name: ${JSON.stringify(toolName)},
        label: ${JSON.stringify(toolName)},
        description: "The ${toolName} tool.",
        parameters: { type: "object", properties: {} },
        async execute(_id, _params, _signal, _update, ctx) {
            return { content: [{ type: "text", text: ${text} }], details: {} };
        },
    });`;

    writeFileSync(
        file,
        `export default function (pi) {${tool("ext_tool", '"cwd=" + ctx.cwd')}${tool("other_tool", '"other"')}${extra}
}
`,
    );

    return file;
}

function offered(path: string, names = ["ext_tool"]): () => ExtensionTool[] {
    return () => names.map((name) => ({ name, description: `The ${name} tool.`, path }));
}

function spawnCount(fx: Fixture): number {
    return fx.parent
        .getEntries()
        .filter(
            (entry) =>
                entry.type === "custom" &&
                (entry as { customType?: string }).customType === RUN_ENTRY_TYPE,
        ).length;
}

function runFiles(fx: Fixture): string[] {
    const dir = join(fx.agentDir, "lune-subagents", "sessions", fx.parent.getSessionId());

    return existsSync(dir) ? readdirSync(dir) : [];
}

function toolNames(run: Parameters<typeof liveSessionOf>[0]) {
    const { session } = liveSessionOf(run);

    return {
        all: session.getAllTools().map((tool) => tool.name),
        active: session.getActiveToolNames(),
    };
}

test("a run that selects an extension tool has it and not the other tools of its extension", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work", tools: ["read", "ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const { all, active } = toolNames(run);

    assert.ok(all.includes("ext_tool"));
    assert.ok(active.includes("ext_tool"));
    assert.ok(!all.includes("other_tool"));
});

test("the model calls the extension tool in the run and receives its result", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    fx.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ext_tool", {}), { stopReason: "toolUse" }),
        reportResponse("done", "ok"),
    ]);
    const run = await manager.start({ task: "work", tools: ["ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const result = run.transcript().find((message) => message.role === "toolResult");
    const actual =
        result?.role === "toolResult"
            ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : undefined;

    assert.equal(result?.role === "toolResult" && result.isError, false);
    assert.equal(actual, `cwd=${run.snapshot!.cwd}`);
});

test("an extension that also registers bash does not replace the run's native bash", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(
        fx,
        `pi.registerTool({
        name: "bash",
        label: "bash",
        description: "Replacement.",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "replaced" }], details: {} }; },
    });`,
    );
    // The parent offers only ext_tool: bash is the run's own name and is left out of the list.
    const manager = fx.createManager([], fx.ctx, offered(path));

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work", tools: ["bash", "ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const { session } = liveSessionOf(run);
    const bash = session.getAllTools().find((tool) => tool.name === "bash");
    const actual = { description: bash?.description, path: bash?.sourceInfo.path };

    assert.notEqual(actual.description, "Replacement.");
    assert.ok(actual.path?.startsWith("builtin:"), String(actual.path));
    assert.ok(session.getAllTools().some((tool) => tool.name === "ext_tool"));
});

test("a tool that the extension registers in its session_start handler is accepted", async (t) => {
    const fx = await createFixture(t);
    const file = join(fx.root, "late.js");

    writeFileSync(
        file,
        `export default function (pi) {
    pi.on("session_start", () => {
        pi.registerTool({
            name: "late_tool",
            label: "late_tool",
            description: "Registered late.",
            parameters: { type: "object", properties: {} },
            async execute() { return { content: [{ type: "text", text: "late" }], details: {} }; },
        });
        pi.registerTool({
            name: "unselected_late",
            label: "unselected_late",
            description: "Registered late.",
            parameters: { type: "object", properties: {} },
            async execute() { return { content: [{ type: "text", text: "late" }], details: {} }; },
        });
    });
}
`,
    );

    const manager = fx.createManager([], fx.ctx, offered(file, ["late_tool"]));

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work", tools: ["late_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const { all } = toolNames(run);

    assert.ok(all.includes("late_tool"));
    assert.ok(!all.includes("unselected_late"));
});

test("starting a run with an extension tool records an info diagnostic naming the file and tools", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work", tools: ["ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const actual = run.diagnostics
        .filter((diagnostic) => diagnostic.message.startsWith("Loaded the extension"))
        .map((diagnostic) => ({ level: diagnostic.level, message: diagnostic.message }));

    assert.deepEqual(actual, [
        { level: "info", message: `Loaded the extension ${path} for ext_tool.` },
    ]);
});

test("an extension file that fails to load fails the start and leaves no run file or entry", async (t) => {
    const fx = await createFixture(t);
    const missing = join(fx.root, "missing.js");
    const broken = join(fx.root, "broken.js");

    writeFileSync(broken, 'throw new Error("boom");\n');

    for (const path of [missing, broken]) {
        const manager = fx.createManager([], fx.ctx, offered(path));

        await assert.rejects(
            manager.start({ task: "work", tools: ["ext_tool"] }, fx.ctx),
            (error: Error) => {
                assert.ok(
                    error.message.startsWith("The extensions of the run's tools failed to load:\n"),
                    error.message,
                );
                assert.ok(error.message.includes(`${path}: `), error.message);

                return true;
            },
        );

        assert.equal(spawnCount(fx), 0);
        assert.equal(manager.branchRuns().length, 0);
        assert.deepEqual(runFiles(fx), []);
    }
});

test("an extension that does not register the selected tool fails the start and leaves no run file or entry", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path, ["ghost_tool"]));

    await assert.rejects(
        manager.start({ task: "work", tools: ["ghost_tool"] }, fx.ctx),
        new RegExp(
            `The extension ${path.replace(/[.]/g, "\\.")} did not register ghost_tool in the run\\.`,
        ),
    );

    assert.equal(spawnCount(fx), 0);
    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(runFiles(fx), []);
});

test("a name that no extension offers still fails with Not available in a run", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    await assert.rejects(
        manager.start({ task: "work", tools: ["other_tool"] }, fx.ctx),
        /Not available in a run: other_tool\./,
    );

    assert.equal(spawnCount(fx), 0);
    assert.deepEqual(runFiles(fx), []);
});

test("the defaultTools setting can name an extension tool: a run started without tools gets it", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    mkdirSync(fx.agentDir, { recursive: true });
    writeFileSync(
        join(fx.agentDir, "settings.json"),
        JSON.stringify({ defaultTools: ["read", "ext_tool"] }),
    );

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const { all, active } = toolNames(run);

    assert.ok(all.includes("ext_tool"));
    assert.ok(active.includes("ext_tool"));
    assert.ok(!all.includes("other_tool"));
});

test("a closed run that continues with send loads its extension tool again", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    const manager = fx.createManager([], fx.ctx, offered(path));

    fx.faux.setResponses([reportResponse("done", "first")]);
    const run = await manager.start({ task: "work", tools: ["ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);
    await run.close();

    fx.faux.setResponses([reportResponse("done", "second")]);
    const outcome = await manager.send(run, "again", "main-agent");
    await waitForTurns(manager, run, 2);

    const { all } = toolNames(run);

    assert.equal(outcome, "started");
    assert.ok(all.includes("ext_tool"));
    assert.ok(!all.includes("other_tool"));
});

test("continuing a closed run fails when the parent no longer offers its extension tool", async (t) => {
    const fx = await createFixture(t);
    const path = writeExtension(fx);
    let tools = offered(path);
    const manager = fx.createManager([], fx.ctx, () => tools());

    fx.faux.setResponses([reportResponse("done", "first")]);
    const run = await manager.start({ task: "work", tools: ["ext_tool"] }, fx.ctx);
    await waitForTurns(manager, run, 1);
    await run.close();

    tools = () => [];
    fx.faux.setResponses([reportResponse("done", "second")]);

    await assert.rejects(manager.send(run, "again", "main-agent"), /Not available in a run/);
});
