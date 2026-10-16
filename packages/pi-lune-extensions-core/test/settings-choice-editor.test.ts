import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { SettingsChoiceEditor } from "../src/panel/choice-editor.ts";
import type {
    SettingsChoice,
    SettingsChoiceSource,
    SettingsPanelField,
} from "../src/panel/section.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
function editorFor(source: SettingsChoiceSource, initial: unknown = null) {
    const saved: unknown[] = [];
    let returned = 0;
    let notify = () => {};
    const field: SettingsPanelField = {
        id: "choices",
        label: "Choices",
        schema: source.multiple
            ? Type.Array(Type.String())
            : Type.Union([Type.Null(), Type.String()]),
        choiceSource: source,
        scopes: ["global", "project"],
        inspect: () => ({
            value: initial,
            defaultValue: initial,
            globalValue: undefined,
            projectValue: undefined,
            source: "default",
        }),
        set: async () => {},
        reset: async () => {},
    };
    const editor = new SettingsChoiceEditor(
        field,
        {} as ExtensionContext,
        "global",
        theme,
        () => notify(),
        async (value) => {
            saved.push(value);
        },
        () => {
            returned++;
            editor.dispose();
            notify();
        },
    );
    const text = () => editor.render(150).map(stripTerminalSequences).join("\n");
    const body = (width = 150) => editor.renderBody(width).map(stripTerminalSequences);
    const ready = () => returned > 0 || !text().includes("Saving / loading");
    return {
        editor,
        text,
        body,
        saved,
        returned: () => returned,
        wait: () =>
            ready()
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      notify = () => {
                          if (ready()) resolve();
                      };
                  }),
    };
}

test(
    "asynchronous choices expose loading, reject early saves and persist after completion",
    { timeout: 5000 },
    async () => {
        const choices = deferred<SettingsChoice[]>();
        const f = editorFor({ load: () => choices.promise });
        assert.match(f.text(), /Saving \/ loading/);
        f.editor.handleInput("\r");
        assert.deepEqual(f.saved, []);
        const ready = f.wait();
        choices.resolve([{ value: "configured", label: "Configured model" }]);
        await ready;
        assert.match(f.text(), /Configured model/);
        f.editor.handleInput("\r");
        await f.wait();
        assert.deepEqual(f.saved, ["configured"]);
        assert.equal(f.returned(), 1);
    },
);

test(
    "closing an asynchronous selector aborts discovery and ignores late choices",
    { timeout: 5000 },
    async () => {
        const choices = deferred<SettingsChoice[]>();
        let signal: AbortSignal | undefined;
        const f = editorFor({
            load: (context) => {
                signal = context.signal;
                return choices.promise;
            },
        });
        f.editor.handleInput("\x1b");
        assert.equal(signal?.aborted, true);
        choices.resolve([{ value: "late", label: "Late model" }]);
        await choices.promise;
        assert.deepEqual(f.saved, []);
        assert.doesNotMatch(f.text(), /Late model/);
    },
);

test(
    "failed asynchronous discovery reports the error and cannot save a model",
    { timeout: 5000 },
    async () => {
        const f = editorFor({
            load: async () => {
                throw new Error("Authentication discovery failed");
            },
        });
        await f.wait();
        assert.match(f.text(), /Authentication discovery failed/);
        f.editor.handleInput("\r");
        assert.deepEqual(f.saved, []);
        f.editor.dispose();
    },
);

test(
    "multi-select preserves hidden selections and Enter can save an empty array",
    { timeout: 5000 },
    async () => {
        const f = editorFor({ multiple: true, load: () => [{ value: "read", label: "read" }] }, [
            "read",
            "unavailable",
        ]);
        f.editor.handleInput(" ");
        f.editor.handleInput("\r");
        await f.wait();
        assert.deepEqual(f.saved, [["unavailable"]]);
        const empty = editorFor({ multiple: true, load: () => [] }, []);
        empty.editor.handleInput("\r");
        await empty.wait();
        assert.deepEqual(empty.saved, [[]]);
    },
);

test("inline choice details reserve a row and wrap long descriptions", () => {
    // Inline choice details keep the selector steady for short text and remain readable when longer.
    const withoutDetails = editorFor(
        { rowLayout: "inline", load: () => [{ value: "plain", label: "Plain" }] },
        "plain",
    );
    const withOneLine = editorFor(
        {
            rowLayout: "inline",
            load: () => [{ value: "short", label: "Short", description: "One useful detail." }],
        },
        "short",
    );
    const withLongDetails = editorFor(
        {
            rowLayout: "inline",
            load: () => [
                {
                    value: "long",
                    label: "Long",
                    description:
                        "A longer choice description wraps over multiple terminal rows and ends with visible detail.",
                },
            ],
        },
        "long",
    );

    const plainBody = withoutDetails.body(32);
    const shortBody = withOneLine.body(32);
    const longBody = withLongDetails.body(32);
    assert.equal(plainBody.length, shortBody.length);
    assert.ok(shortBody.some((line) => line.includes("One useful detail.")));
    assert.equal(longBody.length, shortBody.length + 2);
    assert.ok(longBody.some((line) => line.includes("A longer choice")));
    assert.ok(longBody.some((line) => line.includes("visible")));

    withoutDetails.editor.dispose();
    withOneLine.editor.dispose();
    withLongDetails.editor.dispose();
});
