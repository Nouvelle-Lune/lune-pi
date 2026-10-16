import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { TextPanel, type TextPanelItem } from "../src/ui/text-panel.ts";

function fixture(items: TextPanelItem[], copy = async (_text: string) => {}) {
    initTheme("dark");
    let rows = 24;
    let closed = false;
    const notices: { message: string; level: string | undefined }[] = [];
    const panel = new TextPanel({
        title: "Fixture",
        items,
        theme: () => getThemeByName("dark")!,
        rows: () => rows,
        repaint() {},
        close: () => {
            closed = true;
        },
        copy,
        notify: (message, level) => notices.push({ message, level }),
    });
    const render = (width = 120) => panel.render(width).map(stripVTControlCharacters);
    const position = () => {
        const status = render()[1]!.match(/(\d+)–(\d+) \/ (\d+) rows/);
        assert.ok(status);
        return { top: Number(status[1]), end: Number(status[2]), total: Number(status[3]) };
    };
    const click = (label: string, width = 120) => {
        const lines = render(width);
        const y = lines.findIndex((line) => line.includes(label));
        assert.ok(y >= 0, `Visible click target: ${label}`);
        panel.handleMouse({
            type: "press",
            button: "left",
            x: lines[y]!.indexOf(label),
            y,
        } as TuiMouseEvent);
    };
    return {
        panel,
        render,
        position,
        click,
        notices,
        closed: () => closed,
        resize: (height: number) => {
            rows = height;
        },
    };
}

const numbered = (count: number) =>
    Array.from({ length: count }, (_, index) => `row-${String(index + 1).padStart(3, "0")}`).join(
        "\n",
    );

test("a single output scrolls by row, wheel and page with bounded Home/End navigation", () => {
    const runtime = fixture([{ label: "Output", content: numbered(100) }]);
    const { panel, position } = runtime;
    const initial = position();
    panel.handleInput("\x1b[B");
    assert.equal(position().top, 2);
    panel.handleInput("\x1b[A");
    assert.equal(position().top, 1);
    panel.handleMouse({ type: "wheel", x: 30, y: 5, wheelDelta: 3 } as TuiMouseEvent);
    assert.equal(position().top, 4);
    panel.handleInput("\x1b[6~");
    assert.equal(position().top, 4 + initial.end);
    panel.handleInput("\x1b[5~");
    assert.equal(position().top, 4);
    panel.handleInput("\x1b[F");
    assert.equal(position().end, 100);
    assert.match(runtime.render().join("\n"), /row-100/);
    panel.handleMouse({ type: "wheel", x: 30, y: 5, wheelDelta: 1000 } as TuiMouseEvent);
    assert.equal(position().end, 100);
    panel.handleInput("\x1b[H");
    assert.deepEqual(position(), initial);
    panel.handleInput("\x1b");
    assert.equal(runtime.closed(), true);
});

test("Up/Down and category clicks select categories without wrapping past either end", () => {
    const runtime = fixture([
        { label: "Overview", content: numbered(100) },
        { label: "Memory", content: "memory-only" },
        { label: "Messages", content: "messages-only" },
    ]);
    runtime.render();
    runtime.panel.handleInput("\x1b[F");
    runtime.panel.handleInput("\x1b[B");
    const memory = runtime.render().join("\n");
    assert.match(memory, /› Memory/);
    assert.match(memory, /memory-only/);
    assert.deepEqual(runtime.position(), { top: 1, end: 1, total: 1 });
    runtime.panel.handleInput("\x1b[A");
    assert.match(runtime.render().join("\n"), /row-001/);
    runtime.panel.handleInput("\x1b[A");
    assert.match(runtime.render().join("\n"), /› Overview/);
    runtime.click("Messages");
    assert.match(runtime.render().join("\n"), /messages-only/);
    runtime.panel.handleInput("\x1b[B");
    assert.match(runtime.render().join("\n"), /› Messages/);
    runtime.click("Memory");
    assert.match(runtime.render().join("\n"), /memory-only/);
    assert.equal(runtime.closed(), false);
});

test("the wheel selects categories over the left pane and scrolls content over the right pane", () => {
    // The two wheel regions follow Shell Inspector and must never leak to the underlying transcript.
    const runtime = fixture([
        { label: "Overview", content: numbered(100) },
        { label: "Memory", content: numbered(100) },
        { label: "Messages", content: "messages-only" },
    ]);
    runtime.render();
    const wheel = (x: number, wheelDelta: number) =>
        runtime.panel.handleMouse({ type: "wheel", x, y: 5, wheelDelta } as TuiMouseEvent);
    assert.deepEqual(wheel(60, 3), { handled: true });
    assert.equal(runtime.position().top, 4);
    assert.match(runtime.render().join("\n"), /› Overview/);
    assert.deepEqual(wheel(5, 1), { handled: true });
    assert.match(runtime.render().join("\n"), /› Memory/);
    assert.equal(runtime.position().top, 1);
    wheel(60, 2);
    assert.equal(runtime.position().top, 3);
    wheel(5, 100);
    assert.match(runtime.render().join("\n"), /› Messages/);
    wheel(5, -100);
    assert.match(runtime.render().join("\n"), /› Overview/);
    runtime.panel.handleInput("\x1b[1;2B");
    assert.equal(runtime.position().top, 2);
    runtime.panel.handleInput("\x1b[1;2A");
    assert.equal(runtime.position().top, 1);
    runtime.panel.handleInput("\x1b[6~");
    assert.ok(runtime.position().top > 1);
    runtime.panel.handleInput("\x1b[5~");
    assert.equal(runtime.position().top, 1);
});

test("Tab, Shift+Tab and Left/Right have no action or footer hints", () => {
    const runtime = fixture([
        { label: "Overview", content: numbered(100) },
        { label: "Memory", content: "memory-only" },
    ]);
    runtime.render();
    runtime.panel.handleInput("\x1b[6~");
    const before = runtime.render();
    for (const key of ["\t", "\x1b[Z", "\x1b[C", "\x1b[D"]) runtime.panel.handleInput(key);
    assert.deepEqual(runtime.render(), before);
    assert.doesNotMatch(before.at(-2)!, /Tab|←|→|columns/);
});

test("long text and wide characters wrap completely and reflow to the content pane on resize", () => {
    const content = "中文🌙".repeat(35);
    const runtime = fixture([
        { label: "Overview", content },
        { label: "Memory", content: "memory-only" },
    ]);
    runtime.resize(40);
    let narrowRows = 0;
    for (const width of [56, 120]) {
        const frame = runtime.render(width);
        const body = frame.slice(3, -3).map((row) => row.split("│")[2]!.trim());
        assert.equal(body.join(""), content);
        assert.ok(frame.every((row) => visibleWidth(row) <= width));
        const used = body.filter(Boolean).length;
        if (width === 56) narrowRows = used;
        else assert.ok(used < narrowRows, "A wider pane needs fewer visual rows");
    }
});

test("short and narrow frames keep the selected category visible and clickable", () => {
    const runtime = fixture(
        [
            "Overview",
            "System prompt",
            "Memory",
            "Skills",
            "Tool definitions",
            "Tool results",
            "Messages",
        ].map((label) => ({ label, content: `${label}-content` })),
    );
    runtime.render();
    for (let index = 0; index < 6; index++) runtime.panel.handleInput("\x1b[B");
    assert.match(runtime.render(56).join("\n"), /Messages-content/);
    runtime.click("Tool results", 56);
    assert.match(runtime.render(56).join("\n"), /Tool results-content/);
    runtime.resize(14);
    const short = runtime.render(120);
    assert.equal(short.length, 10);
    assert.match(short.join("\n"), /› Tool results/);
    runtime.panel.handleInput("\x1b[B");
    assert.match(runtime.render(120).join("\n"), /› Messages/);
    for (const width of [20, 56, 72, 120])
        assert.ok(runtime.render(width).every((line) => visibleWidth(line) <= width));
});

test("content presses and drags remain available to native text selection", () => {
    const runtime = fixture([
        { label: "Overview", content: "content" },
        { label: "Memory", content: "memory" },
    ]);
    runtime.render();
    for (const type of ["press", "drag", "move", "click"] as const)
        assert.equal(
            runtime.panel.handleMouse({ type, button: "left", x: 60, y: 5 } as TuiMouseEvent),
            undefined,
        );
    assert.equal(runtime.closed(), false);
});

test("context content beyond the former preview cap is reachable and copied in full", async () => {
    // The sentinel is past 512,000 characters, where the previous inspector discarded its preview.
    const content =
        "## literal Markdown heading\n" +
        "context payload ".repeat(4).concat("\n").repeat(10000) +
        "final-context-sentinel";
    const copied: string[] = [];
    const runtime = fixture(
        [
            { label: "Overview", content },
            { label: "Memory", content: "selected-memory" },
        ],
        async (text) => {
            copied.push(text);
        },
    );
    assert.match(runtime.render().join("\n"), /## literal Markdown heading/);
    runtime.panel.handleInput("\x1b[F");
    assert.match(runtime.render().join("\n"), /final-context-sentinel/);
    runtime.panel.handleInput("c");
    await Promise.resolve();
    assert.deepEqual(copied, [content]);
    runtime.panel.handleInput("\x1b[B");
    runtime.panel.handleInput("\x03");
    await Promise.resolve();
    assert.deepEqual(copied, [content, "selected-memory"]);
    assert.ok(runtime.notices.every((notice) => notice.level === "info"));
});

test("copy failures are reported without closing the selected category or claiming success", async () => {
    const runtime = fixture([{ label: "Messages", content: "content" }], async () => {
        throw new Error("clipboard unavailable");
    });
    runtime.panel.handleInput("c");
    await Promise.resolve();
    assert.deepEqual(runtime.notices, [
        { message: "Error: clipboard unavailable", level: "error" },
    ]);
    assert.equal(runtime.closed(), false);
    assert.match(runtime.render().join("\n"), /content/);
});
