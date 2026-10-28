import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { openSubagentInspector } from "../../src/inspector/inspector.ts";
import { createFixture, reportResponse, waitForTurns } from "../harness/fixture.ts";
import { createFakeTheme } from "../harness/theme.ts";

test("the panel shows the transcript error row for a restored run whose file was deleted", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);

    const original = await first.start({ task: "work" }, fx.ctx);

    await waitForTurns(first, original, 1);
    await first.shutdown();

    const second = fx.createManager();

    second.restore();

    const run = second.branchRun(original.id);

    // The file was readable at restore time; only the later transcript read fails.
    assert.equal(run.loadError, undefined);
    rmSync(run.file);

    let component: Component | undefined;
    let closed!: () => void;
    const wasClosed = new Promise<void>((resolve) => {
        closed = resolve;
    });
    const theme = {
        ...createFakeTheme(),
        fg: (color: string, text: string) => `<${color}:${text}>`,
    };
    const ui = {
        theme,
        custom: async (
            factory: (
                tui: unknown,
                theme: unknown,
                keybindings: unknown,
                done: () => void,
            ) => Component,
        ) => {
            component = factory(
                { requestRender: () => undefined, terminal: { rows: 40, columns: 120 } },
                theme,
                {},
                closed,
            );
            await wasClosed;
        },
    };
    const ctx = Object.create(fx.ctx, { ui: { value: ui } }) as ExtensionContext;
    const opened = openSubagentInspector({ ctx, manager: second, onSeen: () => undefined });

    assert.ok(component, "the panel component was not created");

    const rows = component.render(120);

    assert.ok(
        rows.some((row) => /<error:.*The run transcript cannot be read:/.test(row)),
        `no error row in:\n${rows.join("\n")}`,
    );

    // Escape closes the panel.
    component.handleInput?.("\u001b");
    await opened;
});
