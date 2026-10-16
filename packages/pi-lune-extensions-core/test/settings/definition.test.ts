import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, type Static } from "typebox";
import { defineSettings, type SettingsDefinition } from "../../src/settings/index.ts";
import {
    defineSettingsPanel,
    type SettingsPanelFieldDefinition,
    type SettingsFieldBuilder,
    type SettingsChoiceSource,
    type SettingsPreview,
} from "../../src/panel/index.ts";

test("settings definitions freeze schema defaults without acquiring resources or UI", () => {
    const items = ["initial"];
    const schema = Type.Object({ items: Type.Array(Type.String(), { default: items }) });
    const definition = defineSettings({ id: "sample", schema });
    items.push("caller mutation");
    const actual = Reflect.get(definition.schema.properties.items, "default");
    assert.deepEqual(actual, ["initial"]);
    assert.ok(Object.isFrozen(definition.schema));
    assert.ok(Object.isFrozen(actual));
    assert.equal("panel" in definition, false);
    assert.throws(() => defineSettings({ id: "sample", schema, panel: {} } as never), /separately/);
});

for (const declaration of ["array", "builder"] as const) {
    test(`independent panels snapshot and freeze ${declaration} declarations`, () => {
        const schema = Type.Object({
            enabled: Type.Boolean({ default: true }),
            appearance: Type.Object({ color: Type.String() }, { default: { color: "blue" } }),
            selection: Type.Object(
                { provider: Type.Literal("a"), tags: Type.Array(Type.String()) },
                { default: { provider: "a", tags: ["initial"] } },
            ),
        });
        const path: ["appearance", "color"] = ["appearance", "color"];
        const value = { provider: "a" as const, tags: ["initial"] };
        const choice = { value, label: "A" };
        const choices = [choice];
        const enabledField = { path: "enabled" as const, label: "Enabled" };
        const fields: SettingsPanelFieldDefinition<typeof schema>[] = [
            enabledField,
            { path },
            { path: "selection", choices },
        ];
        const options = {
            id: "sample-panel",
            label: "Sample",
            fields: declaration === "builder" ? () => fields : fields,
        };
        const settings = defineSettings({ id: "sample", schema });
        const panel = defineSettingsPanel(settings, options);
        options.id = "changed";
        options.label = "Changed";
        fields.push({ path: "enabled" });
        enabledField.path = "missing" as never;
        enabledField.label = "Changed";
        path[1] = "missing" as never;
        choices.push({ value: { provider: "a", tags: [] }, label: "B" });
        choice.label = "Changed";
        value.provider = "invalid" as never;
        value.tags.push("caller mutation");
        const actual = {
            id: panel.id,
            label: panel.label,
            fields: panel.fields.map(({ path, label, choices }) => ({
                path,
                ...(label === undefined ? {} : { label }),
                ...(choices === undefined ? {} : { choices }),
            })),
        };
        const expected = {
            id: "sample-panel",
            label: "Sample",
            fields: [
                { path: "enabled", label: "Enabled" },
                { path: ["appearance", "color"] },
                {
                    path: "selection",
                    choices: [{ value: { provider: "a", tags: ["initial"] }, label: "A" }],
                },
            ],
        };
        assert.deepEqual(actual, expected);
        assert.strictEqual(panel.settings, settings);
        assert.ok(Object.isFrozen(panel));
        assert.ok(Object.isFrozen(panel.fields));
        for (const field of panel.fields) assert.ok(Object.isFrozen(field));
        assert.ok(Object.isFrozen(panel.fields[1]!.path));
        const copied = panel.fields[2]!.choices!;
        assert.ok(Object.isFrozen(copied));
        assert.ok(Object.isFrozen(copied[0]));
        assert.ok(Object.isFrozen(copied[0]!.value));
        assert.ok(Object.isFrozen(Reflect.get(copied[0]!.value as object, "tags")));
    });
}

test("panel choice sources snapshot options but preserve dynamic callback identities", () => {
    const schema = Type.Object({ tags: Type.Array(Type.String(), { default: [] }) });
    const scopes = ["all", "scoped"];
    let candidates = [{ value: "initial", label: "Initial" }];
    const load = () => candidates;
    const refresh = async () => {};
    const defaultScope = () => "all";
    const choiceSource: SettingsChoiceSource<string, Static<typeof schema>> & { multiple: true } = {
        multiple: true,
        emptyMessage: "No candidates",
        scopes,
        load,
        refresh,
        defaultScope,
    };
    const preview: SettingsPreview<string[], Static<typeof schema>> = () => ({
        render: () => [],
        invalidate() {},
    });
    const formatValue = (value: string[]) => value.join(", ");
    const backend: NonNullable<SettingsDefinition<typeof schema>["backend"]> = () => {
        throw new Error("No acquisition during definition");
    };
    const panel = defineSettingsPanel(defineSettings({ id: "sample", schema, backend }), {
        label: "Sample",
        fields: (field) => [
            field("tags", { choiceSource, presentation: true, preview, formatValue }),
        ],
    });
    scopes.push("caller mutation");
    choiceSource.scopes = ["changed"];
    choiceSource.emptyMessage = "Changed";
    choiceSource.load = () => [];
    choiceSource.refresh = async () => {};
    choiceSource.defaultScope = () => "changed";
    const field = panel.fields[0]!;
    const actual = field.choiceSource!;
    assert.deepEqual(
        { multiple: actual.multiple, emptyMessage: actual.emptyMessage, scopes: actual.scopes },
        { multiple: true, emptyMessage: "No candidates", scopes: ["all", "scoped"] },
    );
    assert.ok(Object.isFrozen(actual));
    assert.ok(Object.isFrozen(actual.scopes));
    assert.strictEqual(actual.load, load);
    assert.strictEqual(actual.refresh, refresh);
    assert.strictEqual(actual.defaultScope, defaultScope);
    assert.strictEqual(field.preview, preview);
    assert.strictEqual(field.formatValue, formatValue);
    assert.strictEqual(panel.settings.backend, backend);
    candidates = [{ value: "later", label: "Later" }];
    assert.strictEqual(Reflect.apply(actual.load, actual, [{}]), candidates);
    assert.equal(Object.isFrozen(load), false);
});

test("panel declarations reject invalid, overlapping, optional paths and editor conflicts before mounting", () => {
    const schema = Type.Object({
        preferences: Type.Object(
            {
                color: Type.String(),
                note: Type.Optional(Type.String()),
                group: Type.Optional(Type.Object({ name: Type.String() })),
            },
            { default: { color: "blue" } },
        ),
        count: Type.Integer({ default: 1 }),
    });
    const settings = defineSettings({ id: "sample", schema });
    assert.throws(() => defineSettings({ id: " ", schema }), /Settings id " " must use lowercase/);
    assert.throws(() => defineSettingsPanel(settings, { label: " " }), /must not be empty/);
    assert.throws(
        () => defineSettingsPanel(settings, { id: " ", label: "Sample" }),
        /must not be empty/,
    );
    assert.throws(
        () =>
            defineSettingsPanel(settings, {
                label: "Sample",
                fields: [{ path: ["preferences", "missing"] as never }],
            }),
        /Unknown settings path/,
    );
    assert.throws(
        () =>
            defineSettingsPanel(settings, {
                label: "Sample",
                fields: [{ path: "preferences" }, { path: ["preferences", "color"] }],
            }),
        /Overlapping/,
    );
    assert.throws(
        () =>
            defineSettingsPanel(settings, {
                label: "Sample",
                fields: [{ path: "count" }, { path: "count" }],
            }),
        /Overlapping/,
    );
    for (const path of [
        ["preferences", "note"],
        ["preferences", "group", "name"],
    ])
        assert.throws(
            () =>
                defineSettingsPanel(settings, {
                    label: "Sample",
                    fields: [{ path: path as never }],
                }),
            /required properties/,
        );
    assert.doesNotThrow(() =>
        defineSettingsPanel(settings, { label: "Sample", fields: [{ path: ["preferences"] }] }),
    );
    assert.throws(
        () =>
            defineSettingsPanel(settings, {
                label: "Sample",
                fields: [{ path: "count", editor: "text" }],
            }),
        /string schema/,
    );
    assert.equal(defineSettingsPanel(settings, { label: "Sample" }).fields.length, 2);
    assert.deepEqual(defineSettingsPanel(settings, { label: "Sample", fields: [] }).fields, []);
});

test("public builders infer nested values and array item choices from their paths", () => {
    const schema = Type.Object({
        enabled: Type.Boolean({ default: true }),
        nested: Type.Object(
            {
                tags: Type.Array(Type.String()),
                optionalNote: Type.Optional(Type.String()),
            },
            { default: { tags: ["initial"] } },
        ),
    });
    const builder: SettingsFieldBuilder<typeof schema> | undefined = undefined;
    void builder;
    const panel = defineSettingsPanel(defineSettings({ id: "typed", schema }), {
        label: "Typed",
        fields: (field) => {
            if (false) {
                // @ts-expect-error Unknown nested paths must be rejected.
                field(["nested", "missing"]);
                // @ts-expect-error Optional properties cannot become separate panel paths.
                field(["nested", "optionalNote"]);
                field(["nested", "tags"], {
                    choiceSource: {
                        multiple: true,
                        load: () => [
                            // @ts-expect-error Array item choices must match the element type.
                            { value: 1, label: "Invalid" },
                        ],
                    },
                });
            }
            return [
                field("enabled", {
                    formatValue: (value, { values }) => `${value && values.enabled}`,
                }),
                field(["nested", "tags"], {
                    formatValue: (value, { values }) => {
                        const tags: string[] = value;
                        const saved: string[] = values.nested.tags;
                        // @ts-expect-error The formatter receives string[] rather than number.
                        const invalid: number = value;
                        void invalid;
                        return `${tags.length}/${saved.length}`;
                    },
                    choiceSource: {
                        multiple: true,
                        load: () => [{ value: "initial", label: "Initial" }],
                    },
                }),
            ];
        },
    });
    assert.deepEqual(
        panel.fields.map(({ path }) => path),
        ["enabled", ["nested", "tags"]],
    );
});

test("settings ids must be lowercase file-safe names starting and ending with a letter or digit", () => {
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    for (const id of ["a", "9", "lune.core", "my_ext-2", "a1"])
        assert.equal(defineSettings({ id, schema }).id, id);
    for (const id of ["", "Upper", "-lead", "trail-", ".dot", "under_", "_x", "a/b", "a b", "../x"])
        assert.throws(() => defineSettings({ id, schema }), {
            name: "TypeError",
            message: /must use lowercase letters, digits/,
        });
});

test("schema keys starting with '$' are reserved for stored metadata", () => {
    const schema = Type.Object({ $version: Type.Integer({ default: 1 }) });
    assert.throws(() => defineSettings({ id: "reserved", schema }), {
        name: "TypeError",
        message: /Setting "\$version" must not start with "\$"/,
    });
});

test("migrations must be functions and cannot be combined with a custom backend", () => {
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    assert.throws(
        () => defineSettings({ id: "bad-migration", schema, migrations: ["no" as never] }),
        { name: "TypeError", message: /migrations must be functions/ },
    );
    assert.throws(
        () =>
            defineSettings({
                id: "migrating-backend",
                schema,
                migrations: [(overrides) => overrides],
                backend: () => {
                    throw new Error("must not be called");
                },
            }),
        { name: "TypeError", message: /cannot combine migrations with a custom backend/ },
    );
});

test("global-only keys must exist in the schema and be unique, and are frozen with the definition", () => {
    const schema = Type.Object({
        token: Type.String({ default: "" }),
        enabled: Type.Boolean({ default: true }),
    });
    assert.throws(
        () => defineSettings({ id: "unknown-key", schema, globalOnly: ["nope" as never] }),
        {
            name: "TypeError",
            message: /Unknown global-only setting "nope"/,
        },
    );
    assert.throws(() => defineSettings({ id: "dup-key", schema, globalOnly: ["token", "token"] }), {
        name: "TypeError",
        message: /Duplicate global-only settings/,
    });
    const defined = defineSettings({ id: "ok-key", schema, globalOnly: ["token"] });
    assert.deepEqual(defined.globalOnly, ["token"]);
    assert.ok(Object.isFrozen(defined.globalOnly));
    assert.deepEqual(defineSettings({ id: "none", schema }).globalOnly, []);
});
