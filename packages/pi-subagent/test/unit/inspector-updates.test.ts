import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { TuiMouseEvent } from "@earendil-works/pi-tui";

import { SubagentInspector } from "../../src/inspector/inspector.ts";
import { BODY_TOP, paneGeometry } from "../../src/inspector/layout.ts";
import {
    assistantMessage,
    fakeCtx,
    fakeTheme,
    parentSession,
    tempAgentDir,
    turn,
    userMessage,
} from "./support.ts";

const ROWS = 24;
const WIDTH = 120;

/** Two runs in a real manager, opened in an inspector that counts its render requests. */
function panel(t: TestContext) {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);
    const spec = {
        messages: [userMessage("Task."), assistantMessage("Answer.")],
        turns: [turn()],
    };

    session.spawn("aaaa0001", spec);
    session.spawn("aaaa0002", spec);

    const { ctx } = fakeCtx({ sessionManager: session.sessionManager, theme: fakeTheme() });
    const manager = session.manager();
    const [first, second] = manager.branchRuns() as [
        ReturnType<typeof manager.branchRuns>[number],
        ReturnType<typeof manager.branchRuns>[number],
    ];
    const state = { renders: 0 };
    const inspector = new SubagentInspector(
        { ctx, manager, onSeen: () => undefined },
        () => {
            state.renders += 1;
        },
        () => undefined,
        () => ROWS,
    );

    t.after(() => inspector.dispose());
    inspector.render(WIDTH);

    return { inspector, manager, first, second, state, geometry: paneGeometry(WIDTH, ROWS) };
}

test("a state change of any run requests a render", (t) => {
    const { manager, second, state } = panel(t);

    manager.onChange(second, "state");

    assert.equal(state.renders, 1);
});

test("a transcript change of the selected run requests a render", (t) => {
    const { manager, first, state } = panel(t);

    manager.onChange(first, "transcript");

    assert.equal(state.renders, 1);
});

test("a transcript change of another run requests no render", (t) => {
    const { manager, second, state } = panel(t);

    manager.onChange(second, "transcript");

    assert.equal(state.renders, 0);
});

test("after selecting another run its transcript changes request a render and the old one's do not", (t) => {
    const { inspector, manager, first, second, state } = panel(t);

    inspector.handleInput("j");
    state.renders = 0;

    manager.onChange(first, "transcript");
    assert.equal(state.renders, 0);

    manager.onChange(second, "transcript");
    assert.equal(state.renders, 1);
});

test("a press on the transcript is not claimed, the wheel still scrolls it and a press on the list selects", (t) => {
    const { inspector, geometry } = panel(t);
    const event = (partial: Partial<TuiMouseEvent>): TuiMouseEvent =>
        ({ type: "press", button: "left", x: 3, y: BODY_TOP, ...partial }) as TuiMouseEvent;

    assert.equal(
        inspector.handleMouse(event({ x: geometry.rightStart + 3, y: BODY_TOP + 2 })),
        undefined,
    );
    assert.deepEqual(
        inspector.handleMouse(
            event({ type: "wheel", wheelDelta: 1, x: geometry.rightStart + 3, y: BODY_TOP + 2 }),
        ),
        { handled: true },
    );
    assert.deepEqual(inspector.handleMouse(event({ y: BODY_TOP + 1 })), { handled: true });
    assert.match(inspector.render(WIDTH).find((line) => line.includes("aaaa0002 · "))!, /aaaa0002/);
});

// The refresh timer redraws the elapsed time of a running tool, so it runs only while one is shown.

function withTimer(t: TestContext) {
    t.mock.timers.enable({ apis: ["setInterval"] });

    return panel(t);
}

const tool = { toolCallId: "t1", name: "bash", args: {}, startedAt: Date.now() };

test("the refresh timer redraws each second while the selected run has a running tool", (t) => {
    const { inspector, first, state } = withTimer(t);

    first.runningTools.set("t1", tool);
    inspector.render(WIDTH);
    state.renders = 0;

    t.mock.timers.tick(3000);

    assert.equal(state.renders, 3);
});

test("no timer runs when the selected run has no running tool, even if the run works", (t) => {
    const { inspector, first, state } = withTimer(t);

    first.state = "running";
    inspector.render(WIDTH);

    t.mock.timers.tick(3000);

    assert.equal(state.renders, 0);
});

test("a running tool of another run starts no timer", (t) => {
    const { inspector, second, state } = withTimer(t);

    second.runningTools.set("t1", tool);
    inspector.render(WIDTH);

    t.mock.timers.tick(3000);

    assert.equal(state.renders, 0);
});

test("the timer stops once the tool is done and while the details view is on", (t) => {
    const { inspector, first, state } = withTimer(t);

    first.runningTools.set("t1", tool);
    inspector.render(WIDTH);
    inspector.handleInput("d");
    inspector.render(WIDTH);
    state.renders = 0;

    t.mock.timers.tick(3000);
    assert.equal(state.renders, 0);

    inspector.handleInput("d");
    inspector.render(WIDTH);
    state.renders = 0;
    t.mock.timers.tick(1000);
    assert.equal(state.renders, 1);

    first.runningTools.clear();
    inspector.render(WIDTH);
    state.renders = 0;

    t.mock.timers.tick(3000);
    assert.equal(state.renders, 0);
});
