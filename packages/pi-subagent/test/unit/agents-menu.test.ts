import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import type { SettingsPanelField } from "@lune_99/pi-lune-extensions-core/panel";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

import type { AgentDefinition } from "../../src/definitions.ts";
import { createSubagentPanel } from "../../src/settings/panel.ts";
import { subagentSettings } from "../../src/settings/schema.ts";

const REVIEWER = `---
name: reviewer
# keep me
description: Reviews diffs
model: prov/big
tools: read, grep
---
You review.
`;

function fakeModel(id: string) {
    return { provider: "prov", id, name: id.toUpperCase() };
}

async function setup(
    t: TestContext,
    options: {
        trusted?: boolean;
        stored?: Record<string, unknown>;
        scoped?: string[];
        available?: string[];
    } = {},
) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-agents-menu-" });

    if (options.stored) await sandbox.writeStored(subagentSettings, "global", options.stored);

    const lease = await sandbox.acquire(subagentSettings);
    const edits: Array<{ previous: string; edited: AgentDefinition }> = [];
    const panel = createSubagentPanel({
        catalog: () => undefined,
        onEdit: (previous, edited) => edits.push({ previous, edited }),
    });
    const section = createDefinedSettingsSection(lease.settings, panel);
    const ctx = {
        cwd: sandbox.cwd,
        isProjectTrusted: () => options.trusted ?? true,
        scopedModels: (options.scoped ?? []).map((id) => ({ model: fakeModel(id) })),
        modelRegistry: {
            getAvailable: () => (options.available ?? options.scoped ?? []).map(fakeModel),
            getProviderDisplayName: (provider: string) => provider,
        },
    } as unknown as ExtensionContext;

    t.after(async () => {
        await lease.release();
        await sandbox.dispose();
    });

    const dir = (scope: "global" | "project") =>
        scope === "global"
            ? join(sandbox.agentDir, "lune-subagents")
            : join(sandbox.cwd, ".pi", "lune-subagents");
    const write = (scope: "global" | "project", name: string, content: string) => {
        mkdirSync(dir(scope), { recursive: true });
        writeFileSync(join(dir(scope), name), content);

        return join(dir(scope), name);
    };
    const menu = section.fields.find((field) => field.id === "agents")!;
    const open = (scope: "global" | "project") => menu.menu!(ctx, scope);
    const page = (entry: SettingsPanelField, scope: "global" | "project") =>
        entry.menu!(ctx, scope).fields;

    return { section, menu, ctx, edits, dir, write, open, page, lease };
}

const byId = (fields: readonly SettingsPanelField[], id: string) =>
    fields.find((field) => field.id === id)!;

test("the Subagents section lists the auto settings and the Custom agents menu after them", async (t) => {
    const { section, menu } = await setup(t);

    assert.deepEqual(
        section.fields.map((field) => field.id),
        ["allowedModels", "autoClassifier", "tiers", "agents"],
    );
    assert.equal(menu.label, "Custom agents");
    assert.equal(menu.editor, "menu");
});

test("global scope lists the user folder's agents, project scope the project folder's", async (t) => {
    const { write, open } = await setup(t);

    write("global", "reviewer.md", REVIEWER);
    write("project", "local.md", "---\nname: local\ndescription: Local one\n---\n");

    assert.deepEqual(
        open("global").fields.map((field) => field.label),
        ["reviewer"],
    );
    assert.deepEqual(
        open("project").fields.map((field) => field.label),
        ["local"],
    );
});

test("the menu summary counts the scope's agents and the files that do not load", async (t) => {
    const { write, menu, ctx } = await setup(t);

    assert.equal(menu.formatValue?.(undefined, ctx, "global"), "0 user agents");

    write("global", "reviewer.md", REVIEWER);
    write("global", "broken.md", "---\nname: bad name\ndescription: x\n---\n");

    assert.equal(menu.formatValue?.(undefined, ctx, "global"), "1 user agent · 1 not loaded");
});

test("an untrusted project's summary is empty and its folder is not read", async (t) => {
    const { write, menu, ctx } = await setup(t, { trusted: false });

    write("project", "local.md", "---\nname: local\ndescription: Local one\n---\n");

    assert.equal(menu.formatValue?.(undefined, ctx, "project"), "");
});

test("an empty folder gives the empty message naming it", async (t) => {
    const { open, dir } = await setup(t);

    const actual = open("project");

    assert.deepEqual(actual.fields, []);
    assert.match(
        actual.emptyMessage!,
        new RegExp(
            `No project agents in .*${dir("project").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
    );
});

test("a file that does not load is a disabled row with the problem as description", async (t) => {
    const { write, open, ctx } = await setup(t);

    write("global", "broken.md", "---\nname: bad name\ndescription: x\n---\n");

    const [row] = open("global").fields;

    assert.equal(row!.label, "broken.md");
    assert.match(row!.description!, /Invalid name/);
    assert.equal(row!.formatValue?.(undefined, ctx, "global"), "Not loaded");
    assert.ok(row!.disabled?.(ctx, "global"));
});

test("an agent's page lists Name, Description, Model, Thinking, Tools and Isolation", async (t) => {
    const { write, open, page } = await setup(t);

    write("global", "reviewer.md", REVIEWER);

    const fields = page(open("global").fields[0]!, "global");

    assert.deepEqual(
        fields.map((field) => field.id),
        ["name", "description", "model", "thinking", "tools", "isolation"],
    );
    assert.equal(fields[2]!.inspect().value, "prov/big");
    assert.deepEqual(fields[4]!.inspect().value, ["read", "grep"]);
    assert.equal(fields[3]!.inspect().value, null);
});

test("an agent's model choices follow the saved allowed-model selection", async (t) => {
    const { write, open, page, ctx, lease } = await setup(t, {
        stored: { allowedModels: [{ provider: "prov", id: "small" }] },
        scoped: ["small", "big"],
    });

    write("global", "reviewer.md", REVIEWER);

    const fields = page(open("global").fields[0]!, "global");
    const choices = await byId(fields, "model").choiceSource!.load({
        context: ctx,
        scope: "global",
        values: lease.settings.snapshot(),
        signal: new AbortController().signal,
    });

    assert.deepEqual(
        choices.map((choice) => [choice.value, choice.label, choice.badge]),
        [
            [null, "Main agent's model", undefined],
            ["auto", "auto", undefined],
            ["prov/small", "small", "prov"],
            ["prov/big", "prov/big", "Not allowed"],
        ],
    );
});

test("setting a field writes the file, keeps its comments and reports the edit", async (t) => {
    const { write, open, page, edits } = await setup(t);
    const file = write("global", "reviewer.md", REVIEWER);
    const fields = page(open("global").fields[0]!, "global");

    await byId(fields, "model").set("auto", "global");
    await byId(fields, "tools").set(["bash"], "global");
    await byId(fields, "isolation").set("worktree", "global");

    const content = readFileSync(file, "utf8");

    assert.match(content, /# keep me/);
    assert.match(content, /model: auto/);
    assert.match(content, /tools: \[bash\]/);
    assert.match(content, /isolation: worktree/);
    assert.deepEqual(
        edits.map((edit) => [edit.previous, edit.edited.file]),
        [
            [file, file],
            [file, file],
            [file, file],
        ],
    );
});

test("null removes an optional field and so does Ctrl+R", async (t) => {
    const { write, open, page } = await setup(t);
    const file = write("global", "reviewer.md", REVIEWER);
    const fields = page(open("global").fields[0]!, "global");

    await byId(fields, "model").set(null, "global");
    assert.doesNotMatch(readFileSync(file, "utf8"), /^model:/m);

    await byId(fields, "tools").reset("global");
    assert.doesNotMatch(readFileSync(file, "utf8"), /^tools:/m);
    assert.match(readFileSync(file, "utf8"), /name: reviewer/);
});

test("Name and Description cannot be reset", async (t) => {
    const { write, open, page } = await setup(t);
    const file = write("global", "reviewer.md", REVIEWER);
    const fields = page(open("global").fields[0]!, "global");

    for (const id of ["name", "description"])
        await assert.rejects(byId(fields, id).reset("global"), /is required/);

    assert.equal(readFileSync(file, "utf8"), REVIEWER);
});

test("a value the definition parser rejects fails the set and leaves the file alone", async (t) => {
    const { write, open, page, edits } = await setup(t);
    const file = write("global", "reviewer.md", REVIEWER);
    const fields = page(open("global").fields[0]!, "global");

    await assert.rejects(byId(fields, "model").set("gpt", "global"), /provider\/id/);

    assert.equal(readFileSync(file, "utf8"), REVIEWER);
    assert.deepEqual(edits, []);
});

test("after a rename the entry keeps its ID, so its page stays open, and shows the new name", async (t) => {
    const { write, open, page, edits, dir } = await setup(t);
    const file = write("global", "reviewer.md", REVIEWER);
    const before = open("global").fields[0]!;
    const fields = page(before, "global");

    await byId(fields, "name").set("code-reviewer", "global");

    const after = open("global").fields[0]!;

    assert.deepEqual(readdirSync(dir("global")), ["code-reviewer.md"]);
    assert.equal(after.id, before.id);
    assert.equal(after.label, "code-reviewer");
    assert.equal(edits[0]!.previous, file);
    assert.equal(edits[0]!.edited.file, join(dir("global"), "code-reviewer.md"));
});

test("a rename to a name another agent uses is refused", async (t) => {
    const { write, open, page } = await setup(t);

    write("global", "reviewer.md", REVIEWER);
    write("global", "other.md", "---\nname: other\ndescription: Other\n---\n");

    const reviewer = open("global").fields.find((field) => field.label === "reviewer")!;

    await assert.rejects(
        byId(page(reviewer, "global"), "name").set("other", "global"),
        /already uses/,
    );
});
