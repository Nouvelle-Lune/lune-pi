import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTerminalColors } from "../src/terminal-background.ts";

const RESET = "\x1b]111\x07\x1b]110\x07";
const paint = (bg: string, fg: string) => `\x1b]11;${bg}\x07\x1b]10;${fg}\x07`;
const recorder = () => {
    const writes: string[] = [];
    return { writes, write: (data: string) => void writes.push(data) };
};

// The painted state is process-global; always leave it unpainted.
afterEach(() => setTerminalColors(undefined));

test("painting writes the background and foreground sequences once per distinct color pair", () => {
    const terminal = recorder();
    setTerminalColors(terminal, { background: "#000000", foreground: "#ffffff" });
    setTerminalColors(terminal, { background: "#000000", foreground: "#ffffff" });
    assert.deepEqual(terminal.writes, [paint("#000000", "#ffffff")]);
    setTerminalColors(terminal, { background: "#111111", foreground: "#ffffff" });
    assert.deepEqual(terminal.writes.slice(1), [paint("#111111", "#ffffff")]);
});

test("restoring without a terminal resets the terminal that painted last, only once", () => {
    const terminal = recorder();
    setTerminalColors(terminal, { background: "#000000", foreground: "#ffffff" });
    setTerminalColors(undefined);
    setTerminalColors(undefined);
    assert.deepEqual(terminal.writes, [paint("#000000", "#ffffff"), RESET]);
});

test("restoring with nothing painted writes nothing", () => {
    const terminal = recorder();
    setTerminalColors(terminal);
    setTerminalColors(undefined);
    assert.deepEqual(terminal.writes, []);
});

test("repainting after a reset writes the colors again", () => {
    const terminal = recorder();
    const colors = { background: "#000000", foreground: "#ffffff" };
    setTerminalColors(terminal, colors);
    setTerminalColors(terminal);
    setTerminalColors(terminal, colors);
    assert.deepEqual(terminal.writes, [
        paint("#000000", "#ffffff"),
        RESET,
        paint("#000000", "#ffffff"),
    ]);
});

test("the first paint registers a single process exit hook that resets the painted terminal", () => {
    const before = process.listeners("exit");
    const terminal = recorder();
    setTerminalColors(terminal, { background: "#000000", foreground: "#ffffff" });
    setTerminalColors(terminal, { background: "#111111", foreground: "#ffffff" });
    const added = process.listeners("exit").filter((listener) => !before.includes(listener));
    // An earlier test in this process may already have registered the global hook.
    assert.ok(added.length <= 1);
    const hook = added[0] ?? process.listeners("exit").find((l) => l.name === "resetOnExit");
    assert.ok(hook, "exit hook registered");
    hook(0);
    assert.equal(terminal.writes.at(-1), RESET);
    assert.equal(terminal.writes.length, 3);
    process.removeListener("exit", hook);
});
