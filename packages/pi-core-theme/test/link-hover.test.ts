import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
    getCapabilities,
    getOsc8LinkAtColumn,
    hyperlink,
    setCapabilities,
    stripTerminalSequences,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { patchMethod } from "../src/ui/hover.ts";
import { installLinkHover, underlineHoveredLinks } from "../src/ui/link-hover.ts";

const URL_A = "file:///a";
const URL_B = "file:///b";
const BLUE = "\x1b[38;2;100;150;255m";

function hyperlinks(t: TestContext) {
    const previous = getCapabilities();
    setCapabilities({ ...previous, hyperlinks: true });
    t.after(() => setCapabilities(previous));
}

type Cell = { char: string; underline: boolean; href: string | undefined };

/** Visible characters with the underline and link state the terminal would apply to each. */
function cells(line: string, start = { underline: false }): Cell[] {
    const result: Cell[] = [];
    let underline = start.underline;
    let href: string | undefined;
    const token =
        /\x1b\[([\d;:]*)m|\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|([^\x1b])/g;
    for (const match of line.matchAll(token)) {
        if (match[1] !== undefined) {
            if (match[1] === "") underline = false;
            const parts = match[1].split(";");
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i]!;
                if (part === "0" || part === "24") underline = false;
                else if (part === "4") underline = true;
                else if (part === "38" || part === "48" || part === "58")
                    i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
            }
        } else if (match[2] !== undefined) href = match[2] || undefined;
        else if (match[3] !== undefined) result.push({ char: match[3], underline, href });
    }
    return result;
}

const underlined = (line: string) =>
    cells(line)
        .filter((cell) => cell.underline)
        .map((cell) => cell.char)
        .join("");

const styled = `${BLUE}\x1b[4mtext\x1b[24m\x1b[39m`;

test("underlineHoveredLinks returns a line without OSC 8 unchanged", () => {
    const line = "\x1b[4munderlined\x1b[24m plain";
    assert.equal(underlineHoveredLinks(line, URL_A), line);
    assert.equal(underlineHoveredLinks(line, undefined), line);
});

test("underlineHoveredLinks drops a Markdown link's underline unless it is hovered", (t) => {
    hyperlinks(t);
    const line = `go ${hyperlink(styled, URL_A)} now`;
    assert.equal(underlined(underlineHoveredLinks(line, undefined)), "");
    assert.equal(underlined(underlineHoveredLinks(line, URL_B)), "");
});

test("underlineHoveredLinks underlines every character of the hovered link only", (t) => {
    hyperlinks(t);
    const line = `go ${hyperlink(styled, URL_A)} now`;
    assert.equal(underlined(underlineHoveredLinks(line, URL_A)), "text");
    const plain = `go ${hyperlink("text", URL_A)} now`;
    assert.equal(underlined(underlineHoveredLinks(plain, URL_A)), "text");
    assert.equal(underlined(underlineHoveredLinks(plain, undefined)), "");
});

test("underlineHoveredLinks keeps underline on text outside links", (t) => {
    hyperlinks(t);
    const line = `\x1b[4mbefore\x1b[24m ${hyperlink("link", URL_A)} \x1b[4mafter\x1b[24m`;
    for (const hovered of [undefined, URL_A]) {
        const actual = underlined(underlineHoveredLinks(line, hovered));
        assert.equal(actual, hovered ? "beforelinkafter" : "beforeafter");
    }
});

test("underlineHoveredLinks does not underline text after a hovered link", (t) => {
    hyperlinks(t);
    const line = `${hyperlink("link", URL_A)} tail`;
    const output = cells(underlineHoveredLinks(line, URL_A));
    assert.equal(output.filter((c) => c.href === undefined && c.underline).length, 0);
});

test("underlineHoveredLinks handles each wrapped line of a link the same way", (t) => {
    hyperlinks(t);
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const lines = wrapTextWithAnsi(hyperlink(`${BLUE}\x1b[4m${text}\x1b[24m\x1b[39m`, URL_A), 20);
    assert.ok(lines.length > 1);
    for (const line of lines) {
        const visible = stripTerminalSequences(line);
        assert.equal(underlined(underlineHoveredLinks(line, undefined)), "");
        assert.equal(underlined(underlineHoveredLinks(line, URL_A)), visible);
    }
});

test("underlineHoveredLinks treats the 4 in 38;5;4 as a color, not underline", (t) => {
    hyperlinks(t);
    const line = hyperlink("\x1b[38;5;4mtext\x1b[39m", URL_A);
    assert.equal(underlined(line), "");
    assert.equal(underlined(underlineHoveredLinks(line, undefined)), "");
    assert.equal(underlined(underlineHoveredLinks(line, URL_A)), "text");
});

test("underlineHoveredLinks underlines only the hovered link among several", (t) => {
    hyperlinks(t);
    const line = `${hyperlink(styled, URL_A)} ${hyperlink("other", URL_B)}`;
    assert.equal(underlined(underlineHoveredLinks(line, URL_A)), "text");
    assert.equal(underlined(underlineHoveredLinks(line, URL_B)), "other");
});

test("underlineHoveredLinks keeps visible text and link columns", (t) => {
    hyperlinks(t);
    const line = `ab ${hyperlink(styled, URL_A)} ${hyperlink("other", URL_B)} z`;
    for (const hovered of [undefined, URL_A, URL_B]) {
        const output = underlineHoveredLinks(line, hovered);
        assert.equal(stripTerminalSequences(output), stripTerminalSequences(line));
        for (let column = 0; column < 20; column++)
            assert.equal(getOsc8LinkAtColumn(output, column), getOsc8LinkAtColumn(line, column));
    }
    assert.equal(getOsc8LinkAtColumn(underlineHoveredLinks(line, URL_A), 4), URL_A);
});

// A fake TUI whose screen has a link "text" at row 2 (1-based), columns 4-7 (1-based).
function fakeTui() {
    const calls = { input: [] as string[], resets: 0 };
    const screen = ["no link", `abc ${hyperlink("text", URL_A)} end`];
    const originalReset = (lines: string[]) => {
        calls.resets++;
        return [...lines, "marker"];
    };
    const originalInput = (data: string) => {
        calls.input.push(data);
        return "handled";
    };
    const tui = {
        applyLineResets: originalReset,
        handleViewportInput: originalInput,
        getScreenLines: () => screen,
    };
    return { tui, calls, screen, originalReset, originalInput };
}

const move = (x: number, y: number, code = 35) => `\x1b[<${code};${x};${y}M`;
const frameUnderlined = (tui: { applyLineResets: (l: string[]) => string[] }, screen: string[]) =>
    underlined(tui.applyLineResets([...screen]).join(""));

test("installLinkHover decorates lines before the original and passes its result through", (t) => {
    hyperlinks(t);
    const { tui, calls, screen } = fakeTui();
    installLinkHover(tui, () => {});
    const actual = tui.applyLineResets([...screen]);
    assert.equal(calls.resets, 1);
    assert.equal(actual.at(-1), "marker");
    assert.equal(actual.length, screen.length + 1);
    assert.equal(underlined(actual.join("")), "");
});

test("installLinkHover hovers the link under no-button motion and repaints once", (t) => {
    hyperlinks(t);
    const { tui, calls, screen } = fakeTui();
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    assert.equal(tui.handleViewportInput(move(5, 2)), "handled");
    assert.equal(repaints, 1);
    assert.equal(frameUnderlined(tui, screen), "text");
    tui.handleViewportInput(move(6, 2));
    assert.equal(repaints, 1);
    tui.handleViewportInput(move(1, 2));
    assert.equal(repaints, 2);
    assert.equal(frameUnderlined(tui, screen), "");
    assert.equal(calls.input.length, 3);
});

test("installLinkHover clears the hover on a wheel event", (t) => {
    hyperlinks(t);
    for (const code of [64, 65]) {
        const { tui, screen } = fakeTui();
        let repaints = 0;
        installLinkHover(tui, () => repaints++);
        tui.handleViewportInput(move(5, 2));
        tui.handleViewportInput(`\x1b[<${code};5;2M`);
        assert.equal(repaints, 2);
        assert.equal(frameUnderlined(tui, screen), "");
    }
});

test("installLinkHover ignores drags and clicks", (t) => {
    hyperlinks(t);
    const { tui, screen } = fakeTui();
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    tui.handleViewportInput(move(5, 2, 32));
    tui.handleViewportInput(move(5, 2, 0));
    assert.equal(repaints, 0);
    assert.equal(frameUnderlined(tui, screen), "");
    tui.handleViewportInput(move(5, 2));
    tui.handleViewportInput(move(1, 2, 32));
    tui.handleViewportInput(move(1, 2, 0));
    assert.equal(repaints, 1);
    assert.equal(frameUnderlined(tui, screen), "text");
});

test("installLinkHover passes every input to the original unchanged", (t) => {
    hyperlinks(t);
    const { tui, calls } = fakeTui();
    installLinkHover(tui, () => {});
    const inputs = ["a", "\x1b[A", move(5, 2), "\x1b[<64;1;1M"];
    for (const data of inputs) assert.equal(tui.handleViewportInput(data), "handled");
    assert.deepEqual(calls.input, inputs);
});

test("installLinkHover stop restores own-property methods", () => {
    const { tui, originalReset, originalInput } = fakeTui();
    const stop = installLinkHover(tui, () => {});
    assert.notEqual(tui.applyLineResets, originalReset);
    stop();
    assert.equal(tui.applyLineResets, originalReset);
    assert.equal(tui.handleViewportInput, originalInput);
});

test("installLinkHover stop deletes own wrappers when methods come from a prototype", () => {
    class Tui {
        applyLineResets(lines: string[]) {
            return lines;
        }
        handleViewportInput(_data: string) {
            return undefined;
        }
    }
    const tui = new Tui();
    const stop = installLinkHover(tui, () => {});
    assert.ok(Object.hasOwn(tui, "applyLineResets"));
    assert.ok(Object.hasOwn(tui, "handleViewportInput"));
    stop();
    assert.ok(!Object.hasOwn(tui, "applyLineResets"));
    assert.ok(!Object.hasOwn(tui, "handleViewportInput"));
    assert.equal(tui.applyLineResets, Tui.prototype.applyLineResets);
});

test("installLinkHover tolerates a TUI without handleViewportInput or getScreenLines", (t) => {
    hyperlinks(t);
    const bare = { applyLineResets: (lines: string[]) => lines };
    const stop = installLinkHover(bare, () => {});
    assert.deepEqual(bare.applyLineResets(["x"]), ["x"]);
    stop();
    const noScreen = {
        handleViewportInput: (_data: string) => "ok",
        applyLineResets: (lines: string[]) => lines,
    };
    let repaints = 0;
    installLinkHover(noScreen, () => repaints++);
    assert.equal(noScreen.handleViewportInput(move(5, 2)), "ok");
    assert.equal(repaints, 0);
});

test("patchMethod undo leaves a newer wrapper in place", () => {
    const host = { run: () => "base" };
    const base = host.run;
    const undoFirst = patchMethod<() => string>(host, "run", (o) => () => `1(${o()})`);
    const second = patchMethod<() => string>(host, "run", (o) => () => `2(${o()})`);
    undoFirst();
    assert.equal(host.run(), "2(1(base))");
    second();
    assert.equal(host.run(), "1(base)");
    assert.notEqual(host.run, base);
});
