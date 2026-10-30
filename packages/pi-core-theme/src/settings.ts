import { Type, type TLiteral, type TProperties, type TSchema } from "typebox";
import { defineSettings } from "@lune_99/pi-lune-extensions-core";
import { Value } from "typebox/value";
import { paletteNames } from "./palettes/index.ts";

function choice<const T extends readonly string[]>(values: T, initial: T[number]) {
    const variants = values.map((value) => Type.Literal(value)) as {
        -readonly [K in keyof T]: TLiteral<T[K]>;
    };
    return Type.Union<{ -readonly [K in keyof T]: TLiteral<T[K]> }>(
        [...variants] as [...{ -readonly [K in keyof T]: TLiteral<T[K]> }],
        { default: initial },
    );
}
const integer = (initial: number, minimum: number, maximum: number) =>
    Type.Integer({ default: initial, minimum, maximum });

const properties = {
    mode: choice(["on", "compact", "off"] as const, "on"),
    palette: choice(["inherit", ...paletteNames] as const, "inherit"),
    paletteBackground: Type.Boolean({ default: false }),
    excludeRenderers: Type.Array(Type.String({ minLength: 1 }), { default: [], uniqueItems: true }),
    diffViewMode: choice(["auto", "split", "unified"] as const, "auto"),
    diffIndicatorMode: choice(["bars", "classic", "none"] as const, "bars"),
    diffSplitMinWidth: integer(120, 40, 300),
    editDiffCollapsedLines: integer(24, 0, 500),
    writeDiffCollapsedLines: integer(0, 0, 500),
    diffWordWrap: Type.Boolean({ default: true }),
    expandedPreviewMaxLines: integer(40, 1, 2000),
    expandedCardBackground: choice(
        [
            "userMessageBg",
            "toolPendingBg",
            "customMessageBg",
            "selectedBg",
            "searchMatchBg",
            "toolSuccessBg",
            "toolErrorBg",
        ] as const,
        "userMessageBg",
    ),
    expandedInputMaxLines: integer(5, 1, 2000),
    expandedOutputMaxLines: integer(10, 1, 2000),
    toolLabelClip: integer(0, 0, 500),
    previewLines: integer(5, 0, 20),
    animationIntervalMs: integer(300, 40, 2000),
    fullscreenMouse: Type.Boolean({ default: true }),
    showStartupHeader: Type.Boolean({ default: true }),
};

function object<const P extends TProperties>(fields: P) {
    return Type.Object(fields, {
        additionalProperties: false,
        default: Object.fromEntries(
            Object.entries(fields).map(([key, schema]) => [
                key,
                Value.Default(schema as TSchema, undefined),
            ]),
        ),
    });
}

/** Appearance options only; the master switch never reaches the renderer configuration. */
export const themeSchema = object(properties);

export const themeSettings = defineSettings({
    id: "pi-core-theme",
    // Default-off: installing the package must not change Pi's appearance until it is enabled.
    schema: object({ enabled: Type.Boolean({ default: false }), ...properties }),
});
