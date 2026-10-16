import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Type } from "typebox";

import { assertSettingsSchema } from "../src/settings/types.ts";
import { defineSettings } from "../src/settings/index.ts";
import { defineSettingsPanel } from "../src/panel/index.ts";
import type { SettingsSchema } from "../src/settings/types.ts";
import {
    assertSettingsGroups,
    resolveSettingsFieldOptions,
    settingsEditor,
    type SettingsPanelSchema,
} from "../src/panel/section.ts";

const panelSchema = (schema: unknown) => schema as SettingsPanelSchema;

const validSchema = Type.Object({
    maxItems: Type.Integer({ default: 10, minimum: 1 }),
    label: Type.Union([Type.String(), Type.Null()], { default: null }),
});

test("a schema with valid required defaults accepts constrained and nullable settings", () => {
    assert.doesNotThrow(() => assertSettingsSchema(validSchema));
});

const invalidSchemas = [
    {
        description: "a required setting without a default",
        schema: Type.Object({ maxItems: Type.Integer() }),
        message: /Setting "maxItems" must define a default value/,
    },
    {
        description: "a default with the wrong type",
        schema: Type.Object({ maxItems: Type.Integer({ default: "ten" }) }),
        message: /Setting "maxItems" has an invalid default value/,
    },
    {
        description: "a default outside the setting's constraints",
        schema: Type.Object({ maxItems: Type.Integer({ default: 0, minimum: 1 }) }),
        message: /Setting "maxItems" has an invalid default value/,
    },
    {
        description: "an optional setting even when it has a valid default",
        schema: Type.Object({
            maxItems: Type.Optional(Type.Integer({ default: 10 })),
        }),
        message: /Setting "maxItems" must not be optional/,
    },
];

for (const { description, schema, message } of invalidSchemas) {
    test(`schema validation rejects ${description}`, () => {
        assert.throws(() => assertSettingsSchema(schema), {
            name: "TypeError",
            message,
        });
    });
}

// Optional properties cannot satisfy the asserted settings schema type either.
const optionalSchema = Type.Object({
    maxItems: Type.Optional(Type.Integer({ default: 10 })),
});
// @ts-expect-error Optional setting properties are rejected by SettingsSchema.
const optionalProperty: SettingsSchema<typeof optionalSchema>["properties"]["maxItems"] =
    optionalSchema.properties.maxItems;
void optionalProperty;

test("the editor is inferred as number for number and integer schemas only", () => {
    assert.equal(settingsEditor({ schema: panelSchema(Type.Number()) }), "number");
    assert.equal(settingsEditor({ schema: panelSchema(Type.Integer()) }), "number");
    assert.equal(settingsEditor({ schema: panelSchema(Type.String()) }), "text");
    assert.equal(settingsEditor({ schema: panelSchema(Type.Array(Type.Number())) }), "json");
    assert.equal(settingsEditor({ schema: panelSchema(Type.Number()), editor: "json" }), "json");
    assert.equal(resolveSettingsFieldOptions("n", panelSchema(Type.Integer())).editor, "number");
});

test("the number editor requires a number or integer schema", () => {
    for (const schema of [Type.String(), Type.Boolean(), Type.Array(Type.Number())])
        assert.throws(
            () => resolveSettingsFieldOptions("bad", panelSchema(schema), { editor: "number" }),
            {
                name: "TypeError",
                message: 'Number editor requires a number or integer schema for "bad"',
            },
        );
    for (const schema of [Type.Number(), Type.Integer()])
        assert.equal(
            resolveSettingsFieldOptions("ok", panelSchema(schema), { editor: "number" }).editor,
            "number",
        );
});

test("secret settings require a string schema and the text editor", () => {
    assert.equal(
        resolveSettingsFieldOptions("key", panelSchema(Type.String()), { secret: true }).editor,
        "text",
    );
    assert.equal(
        resolveSettingsFieldOptions("key", panelSchema(Type.String()), {
            secret: true,
            editor: "text",
        }).editor,
        "text",
    );
    assert.throws(
        () => resolveSettingsFieldOptions("key", panelSchema(Type.Integer()), { secret: true }),
        { name: "TypeError", message: 'Secret setting "key" requires a string schema' },
    );
    for (const editor of ["json", "select", "cycle"] as const)
        assert.throws(
            () =>
                resolveSettingsFieldOptions("key", panelSchema(Type.String()), {
                    secret: true,
                    editor,
                }),
            { name: "TypeError", message: 'Secret setting "key" requires the text editor' },
        );
});

test("secret settings cannot display their value through choices, previews or formatting", () => {
    const forbidden = {
        choices: [{ value: "a", label: "A" }],
        choiceSource: { load: () => [] },
        preview: () => ({ render: () => [], invalidate() {} }),
        formatValue: () => "shown",
    };
    for (const [name, extra] of Object.entries(forbidden))
        assert.throws(
            () =>
                resolveSettingsFieldOptions("key", panelSchema(Type.String()), {
                    secret: true,
                    [name]: extra,
                }),
            { name: "TypeError", message: /cannot use choices, previews or formatValue/ },
        );
});

const noEditor = () => ({ render: () => [], invalidate() {}, handleInput() {} });

test("field group names must be non-empty strings", () => {
    for (const group of ["", "   ", 5, null])
        assert.throws(
            () =>
                resolveSettingsFieldOptions("g", panelSchema(Type.String()), {
                    group: group as never,
                }),
            { name: "TypeError", message: 'Settings group for "g" must be a non-empty string' },
        );
    assert.doesNotThrow(() =>
        resolveSettingsFieldOptions("g", panelSchema(Type.String()), { group: "Network" }),
    );
    assert.doesNotThrow(() => resolveSettingsFieldOptions("g", panelSchema(Type.String()), {}));
});

test("visible, disabled and customEditor must be functions when supplied", () => {
    for (const name of ["visible", "disabled", "customEditor"])
        for (const value of [true, "yes", {}])
            assert.throws(
                () =>
                    resolveSettingsFieldOptions("f", panelSchema(Type.String()), {
                        [name]: value,
                    }),
                { name: "TypeError", message: `Settings ${name} for "f" must be a function` },
            );
    assert.doesNotThrow(() =>
        resolveSettingsFieldOptions("f", panelSchema(Type.String()), {
            visible: () => true,
            disabled: () => undefined,
        }),
    );
});

test("a custom editor implies and is inferred as the custom editor for any schema", () => {
    for (const schema of [Type.String(), Type.Integer(), Type.Array(Type.String())]) {
        assert.equal(
            resolveSettingsFieldOptions("c", panelSchema(schema), { customEditor: noEditor })
                .editor,
            "custom",
        );
        assert.equal(
            resolveSettingsFieldOptions("c", panelSchema(schema), {
                customEditor: noEditor,
                editor: "custom",
            }).editor,
            "custom",
        );
        assert.equal(
            settingsEditor({ schema: panelSchema(schema), customEditor: noEditor }),
            "custom",
        );
    }
});

test("a custom editor conflicts with any explicit non-custom editor", () => {
    for (const editor of ["text", "number", "json", "select", "cycle"] as const)
        assert.throws(
            () =>
                resolveSettingsFieldOptions("c", panelSchema(Type.String()), {
                    customEditor: noEditor,
                    editor,
                }),
            {
                name: "TypeError",
                message: `Custom editor for "c" conflicts with editor "${editor}"`,
            },
        );
});

test('editor "custom" requires a customEditor', () => {
    assert.throws(
        () => resolveSettingsFieldOptions("c", panelSchema(Type.String()), { editor: "custom" }),
        { name: "TypeError", message: 'Editor "custom" requires a customEditor for "c"' },
    );
});

test("a custom editor cannot be combined with choices, choice sources, secrets or previews", () => {
    const forbidden = {
        choices: [{ value: "a", label: "A" }],
        choiceSource: { load: () => [] },
        secret: true,
        preview: () => ({ render: () => [], invalidate() {} }),
    };
    for (const [name, extra] of Object.entries(forbidden))
        assert.throws(
            () =>
                resolveSettingsFieldOptions("c", panelSchema(Type.String()), {
                    customEditor: noEditor,
                    [name]: extra,
                }),
            {
                name: "TypeError",
                message: /Custom editor for "c" cannot use choices, secret or a preview/,
            },
        );
});

describe("field group layout", () => {
    const layout = (...groups: (string | undefined)[]) => groups.map((group) => ({ group }));

    test("accepts no groups, only groups, and ungrouped fields before adjacent groups", () => {
        for (const fields of [
            layout(),
            layout(undefined, undefined),
            layout("A", "A", "B"),
            layout(undefined, undefined, "A", "A", "B"),
        ])
            assert.doesNotThrow(() => assertSettingsGroups(fields));
    });

    test("rejects a group whose fields are split by another group", () => {
        assert.throws(() => assertSettingsGroups(layout("A", "B", "A")), {
            name: "TypeError",
            message: 'Settings group "A" must list its fields together',
        });
    });

    test("rejects an ungrouped field after a group, naming the group it would fall under", () => {
        assert.throws(() => assertSettingsGroups(layout("A", undefined)), {
            name: "TypeError",
            message: /Ungrouped settings must come before group "A"/,
        });
        assert.throws(() => assertSettingsGroups(layout(undefined, "A", "A", undefined)), {
            name: "TypeError",
            message: /Ungrouped settings must come before group "A"/,
        });
    });

    test("defineSettingsPanel applies the same layout rules to declared fields", () => {
        const settings = defineSettings({
            id: "grouped",
            schema: Type.Object({
                a: Type.String({ default: "" }),
                b: Type.String({ default: "" }),
                c: Type.String({ default: "" }),
            }),
        });
        assert.throws(
            () =>
                defineSettingsPanel(settings, {
                    label: "Grouped",
                    fields: [
                        { path: "a", group: "X" },
                        { path: "b", group: "Y" },
                        { path: "c", group: "X" },
                    ],
                }),
            { name: "TypeError", message: 'Settings group "X" must list its fields together' },
        );
        assert.throws(
            () =>
                defineSettingsPanel(settings, {
                    label: "Grouped",
                    fields: [{ path: "a", group: "X" }, { path: "b" }],
                }),
            { name: "TypeError", message: /Ungrouped settings must come before group "X"/ },
        );
        assert.throws(
            () =>
                defineSettingsPanel(settings, {
                    label: "Grouped",
                    fields: [{ path: "a", group: "" }],
                }),
            {
                name: "TypeError",
                message: 'Settings group for "["a"]" must be a non-empty string',
            },
        );
        const panel = defineSettingsPanel(settings, {
            label: "Grouped",
            fields: [{ path: "a" }, { path: "b", group: "X" }, { path: "c", group: "X" }],
        });
        assert.deepEqual(
            panel.fields.map(({ group }) => group),
            [undefined, "X", "X"],
        );
    });
});
