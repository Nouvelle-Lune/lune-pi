import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import type { SettingsPanelField } from "@lune_99/pi-lune-extensions-core/panel";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";
import { Value } from "typebox/value";

import type { AgentDefinition } from "../../src/definitions.ts";
import { THINKING_LEVELS } from "../../src/run/types.ts";
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

interface ModelMetadata {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
}

// Pi's levels per model: plain has off..high, sparse adds max but lacks minimal and medium,
// nolow lacks minimal and low, nothink lacks off, and small has no reasoning at all.
const MODELS: Record<string, ModelMetadata> = {
    plain: { reasoning: true },
    sparse: {
        reasoning: true,
        thinkingLevelMap: {
            minimal: null,
            medium: null,
            xhigh: null,
            low: "low",
            high: "high",
            max: "max",
        },
    },
    nolow: { reasoning: true, thinkingLevelMap: { minimal: null, low: null } },
    nothink: { reasoning: true, thinkingLevelMap: { off: null } },
    small: { reasoning: false },
};

const NO_TIERS = { light: null, standard: null, complex: null, deep: null };

function fakeModel(id: string, metadata: ModelMetadata = {}) {
    return { provider: "prov", id, name: id.toUpperCase(), ...metadata };
}

/** A definition file with the fields under test; the menu does not read the body. */
function agentFile(name: string, fields: string): string {
    return `---\nname: ${name}\ndescription: Reviews diffs\n${fields}---\nYou review.\n`;
}

async function setup(
    t: TestContext,
    options: {
        trusted?: boolean;
        stored?: Record<string, unknown>;
        scoped?: string[];
        available?: string[];
        models?: Record<string, ModelMetadata>;
        mainModel?: string;
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
    const model = (id: string) => fakeModel(id, options.models?.[id]);
    const ctx = {
        cwd: sandbox.cwd,
        model: options.mainModel ? model(options.mainModel) : undefined,
        isProjectTrusted: () => options.trusted ?? true,
        scopedModels: (options.scoped ?? []).map((id) => ({ model: model(id) })),
        modelRegistry: {
            getAvailable: () => (options.available ?? options.scoped ?? []).map(model),
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
    /** Load a field's choices from the sandbox settings, optionally with another main model. */
    const load = (field: SettingsPanelField, alternatives: { mainModel?: string } = {}) =>
        field.choiceSource!.load({
            context: {
                ...ctx,
                model: alternatives.mainModel ? model(alternatives.mainModel) : ctx.model,
            } as unknown as ExtensionContext,
            scope: "global",
            values: lease.settings.snapshot(),
            signal: new AbortController().signal,
        });
    /** The error a synchronous load throws; the loader must refuse instead of returning rows. */
    const loadError = (field: SettingsPanelField): Error => {
        try {
            load(field);
        } catch (error) {
            return error as Error;
        }

        throw new Error("the thinking choices should not load");
    };

    return { section, menu, ctx, edits, dir, write, open, page, load, loadError, lease };
}

const byId = (fields: readonly SettingsPanelField[], id: string) =>
    fields.find((field) => field.id === id)!;

test("the Subagents section lists the auto settings and the Custom agents menu after them", async (t) => {
    const { section, menu } = await setup(t);

    assert.deepEqual(
        section.fields.map((field) => field.id),
        ["allowedModels", "autoClassifier", "autoOnly", "tiers", "agents"],
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

test("the Auto mode only row follows Auto classifier as a plain on/off setting", async (t) => {
    const { section } = await setup(t);
    const field = section.fields.find((candidate) => candidate.id === "autoOnly")!;

    assert.equal(field.label, "Auto mode only");
});

test("the Thinking field loads its choices per model and keeps the full level schema", async (t) => {
    const { write, open, page } = await setup(t, { models: MODELS, available: ["plain"] });

    write("global", "reviewer.md", agentFile("reviewer", "model: prov/plain\n"));

    const field = byId(page(open("global").fields[0]!, "global"), "thinking");

    assert.ok(field.choiceSource);
    assert.equal(field.choices, undefined);
    assert.equal(Value.Check(field.schema, null), true);
    for (const level of THINKING_LEVELS)
        assert.equal(Value.Check(field.schema, level), true, level);
    assert.equal(Value.Check(field.schema, "ultra"), false);
});

test("a fixed model offers only the levels Pi supports for it", async (t) => {
    const { write, open, page, ctx, load } = await setup(t, {
        models: MODELS,
        available: ["plain", "sparse"],
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: prov/sparse\n"));

    const field = byId(page(open("global").fields[0]!, "global"), "thinking");
    const choices = await load(field);
    const expected = [null, "off", "low", "high", "max"];
    const actual = choices.map((choice) => choice.value);

    assert.deepEqual(actual, expected);
    assert.equal(choices[0]!.label, "Main agent's thinking");
    assert.equal(field.formatValue?.(undefined, ctx, "global"), "Main agent's thinking");
});

test("a model without reasoning offers only off", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        available: ["small"],
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: prov/small\n"));

    const choices = await load(byId(page(open("global").fields[0]!, "global"), "thinking"));

    assert.deepEqual(
        choices.map((choice) => choice.value),
        [null, "off"],
    );
});

test("without a model the levels follow the main model, even outside the allowed set", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        stored: { allowedModels: [{ provider: "prov", id: "small" }] },
        available: ["small", "sparse"],
        mainModel: "sparse",
    });

    write("global", "reviewer.md", agentFile("reviewer", ""));

    const field = byId(page(open("global").fields[0]!, "global"), "thinking");
    const before = (await load(field)).map((choice) => choice.value);
    const after = (await load(field, { mainModel: "small" })).map((choice) => choice.value);

    assert.deepEqual(before, [null, "off", "low", "high", "max"]);
    assert.deepEqual(after, [null, "off"]);
});

test("auto without a classifier uses the main model's levels and the main-thinking label", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        stored: { autoTiers: { ...NO_TIERS, light: { provider: "prov", id: "sparse" } } },
        available: ["small", "sparse"],
        mainModel: "small",
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: auto\n"));

    const choices = await load(byId(page(open("global").fields[0]!, "global"), "thinking"));

    assert.deepEqual(
        choices.map((choice) => choice.value),
        [null, "off"],
    );
    assert.equal(choices[0]!.label, "Main agent's thinking");
});

test("auto with a classifier keeps the main model in the intersection when the deep tier has a model", async (t) => {
    const { write, open, page, ctx, load } = await setup(t, {
        models: MODELS,
        stored: {
            autoClassifier: { provider: "cls", id: "judge" },
            autoTiers: {
                ...NO_TIERS,
                light: { provider: "prov", id: "sparse" },
                deep: { provider: "prov", id: "sparse" },
            },
        },
        available: ["small", "sparse"],
        mainModel: "small",
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: auto\n"));

    const field = byId(page(open("global").fields[0]!, "global"), "thinking");
    const choices = await load(field);
    const expected = [null, "off"];
    const actual = choices.map((choice) => choice.value);

    assert.deepEqual(actual, expected);
    assert.equal(choices[0]!.label, "Automatic thinking");
    assert.match(choices[0]!.description!, /classifier/i);
    assert.equal(field.formatValue?.(undefined, ctx, "global"), "Automatic thinking");
});

test("auto with a classifier offers only the levels every tier model and the main model share", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        stored: {
            autoClassifier: { provider: "cls", id: "judge" },
            autoTiers: {
                ...NO_TIERS,
                light: { provider: "prov", id: "sparse" },
                deep: { provider: "prov", id: "nolow" },
            },
        },
        available: ["plain", "sparse", "nolow"],
        mainModel: "plain",
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: auto\n"));

    const choices = await load(byId(page(open("global").fields[0]!, "global"), "thinking"));
    const expected = [null, "off", "high"];
    const actual = choices.map((choice) => choice.value);

    assert.deepEqual(actual, expected);
});

test("no shared level leaves only the automatic choice with a description saying why", async (t) => {
    const { write, open, page, ctx, load } = await setup(t, {
        models: MODELS,
        stored: {
            autoClassifier: { provider: "cls", id: "judge" },
            autoTiers: { ...NO_TIERS, light: { provider: "prov", id: "nothink" } },
        },
        available: ["small", "nothink"],
        mainModel: "small",
    });

    write("global", "reviewer.md", agentFile("reviewer", "model: auto\n"));

    const field = byId(page(open("global").fields[0]!, "global"), "thinking");
    const choices = await load(field);

    assert.deepEqual(
        choices.map((choice) => choice.value),
        [null],
    );
    assert.equal(choices[0]!.label, "Automatic thinking");
    assert.match(choices[0]!.description!, /no shared thinking level/i);
    assert.equal(choices[0]!.disabled, undefined);
    assert.equal(field.formatValue?.(undefined, ctx, "global"), "Automatic thinking");
});

test("a fixed model that is missing or not allowed fails the load instead of shrinking the list", async (t) => {
    const { write, open, page, loadError } = await setup(t, {
        models: MODELS,
        stored: { allowedModels: [{ provider: "prov", id: "small" }] },
        available: ["small", "sparse"],
    });

    write("global", "ghost.md", agentFile("ghost", "model: prov/ghost\n"));
    write("global", "sparse.md", agentFile("sparse", "model: prov/sparse\n"));

    const thinking = (name: string) =>
        byId(
            page(open("global").fields.find((entry) => entry.label === name)!, "global"),
            "thinking",
        );
    const ghostError = loadError(thinking("ghost"));
    const sparseError = loadError(thinking("sparse"));

    assert.match(ghostError.message, /prov\/ghost/);
    assert.match(ghostError.message, /unavailable|not available|allowed/i);
    assert.match(sparseError.message, /prov\/sparse/);
    assert.match(sparseError.message, /unavailable|not available|allowed/i);
});

test("a tier model that is missing or not allowed fails the load instead of dropping that tier", async (t) => {
    const cases: Array<{
        name: string;
        stored: Record<string, unknown>;
        available: string[];
        mainModel: string;
        ref: string;
    }> = [
        {
            name: "missing",
            stored: {
                autoClassifier: { provider: "cls", id: "judge" },
                autoTiers: { ...NO_TIERS, light: { provider: "prov", id: "ghost" } },
            },
            available: ["small"],
            mainModel: "small",
            ref: "prov/ghost",
        },
        {
            name: "available but not in the allowed set",
            stored: {
                autoClassifier: { provider: "cls", id: "judge" },
                allowedModels: [{ provider: "prov", id: "small" }],
                autoTiers: { ...NO_TIERS, light: { provider: "prov", id: "sparse" } },
            },
            available: ["small", "sparse"],
            // The main model is never filtered by the allowed set, unlike a tier model.
            mainModel: "sparse",
            ref: "prov/sparse",
        },
    ];

    for (const each of cases)
        await t.test(each.name, async (subtest) => {
            const { write, open, page, loadError } = await setup(subtest, {
                models: MODELS,
                stored: each.stored,
                available: each.available,
                mainModel: each.mainModel,
            });

            write("global", "reviewer.md", agentFile("reviewer", "model: auto\n"));

            const error = loadError(byId(page(open("global").fields[0]!, "global"), "thinking"));

            assert.match(error.message, new RegExp(each.ref));
            assert.match(error.message, /unavailable|not available|allowed/i);
        });
});

test("without a current main model the load fails instead of guessing levels", async (t) => {
    const { write, open, page, load } = await setup(t, { models: MODELS, available: ["plain"] });

    write("global", "plain.md", agentFile("plain", ""));
    write("global", "auto.md", agentFile("auto", "model: auto\n"));

    const thinking = (name: string) =>
        byId(
            page(open("global").fields.find((entry) => entry.label === name)!, "global"),
            "thinking",
        );

    assert.throws(() => load(thinking("plain")), /main agent/i);
    assert.throws(() => load(thinking("auto")), /main agent/i);
});

test("a saved level the model does not support stays inspectable and resettable", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        available: ["small"],
    });

    const file = write(
        "global",
        "reviewer.md",
        agentFile("reviewer", "model: prov/small\nthinking: max\n"),
    );

    const fields = page(open("global").fields[0]!, "global");
    const thinking = byId(fields, "thinking");

    assert.equal(thinking.inspect().value, "max");
    assert.deepEqual(
        (await load(thinking)).map((choice) => choice.value),
        [null, "off"],
    );

    await thinking.reset("global");

    assert.doesNotMatch(readFileSync(file, "utf8"), /^thinking:/m);
    assert.match(readFileSync(file, "utf8"), /^model: prov\/small$/m);
});

test("changing the model keeps the saved thinking level and reloads its choices", async (t) => {
    const { write, open, page, load } = await setup(t, {
        models: MODELS,
        available: ["small", "sparse"],
    });

    const file = write(
        "global",
        "reviewer.md",
        agentFile("reviewer", "model: prov/small\nthinking: max\n"),
    );
    const fields = page(open("global").fields[0]!, "global");

    await byId(fields, "model").set("prov/sparse", "global");

    const content = readFileSync(file, "utf8");
    const reopened = page(open("global").fields[0]!, "global");
    const thinking = byId(reopened, "thinking");
    const choices = await load(thinking);

    assert.match(content, /^model: prov\/sparse$/m);
    assert.match(content, /^thinking: max$/m);
    assert.equal(thinking.inspect().value, "max");
    assert.deepEqual(
        choices.map((choice) => choice.value),
        [null, "off", "low", "high", "max"],
    );
});

test("the agent summary says automatic thinking for auto with a classifier", async (t) => {
    const { write, open, ctx } = await setup(t, {
        models: MODELS,
        stored: {
            autoClassifier: { provider: "cls", id: "judge" },
            autoTiers: { ...NO_TIERS, light: { provider: "prov", id: "sparse" } },
        },
        available: ["plain", "sparse"],
        mainModel: "plain",
    });

    write("global", "auto.md", agentFile("auto", "model: auto\n"));
    write("global", "plain.md", agentFile("plain", "model: prov/plain\n"));

    const summary = (name: string) =>
        open("global")
            .fields.find((entry) => entry.label === name)!
            .formatValue?.(undefined, ctx, "global");

    assert.match(summary("auto")!, /automatic thinking/);
    assert.doesNotMatch(summary("auto")!, /main thinking/);
    assert.match(summary("plain")!, /main thinking/);
});
