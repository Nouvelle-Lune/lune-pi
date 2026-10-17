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
import { findLinks, hoveredLinks, installLinkHover, underlineLinks } from "../src/ui/link-hover.ts";

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

const FIRST = new Set([0]);

test("underlineLinks returns a line without OSC 8 unchanged", () => {
    const line = "\x1b[4munderlined\x1b[24m plain";
    assert.equal(underlineLinks(line, FIRST), line);
    assert.equal(underlineLinks(line), line);
});

test("underlineLinks drops a Markdown link's underline unless it is picked", (t) => {
    hyperlinks(t);
    const line = `go ${hyperlink(styled, URL_A)} now`;
    assert.equal(underlined(underlineLinks(line)), "");
    assert.equal(underlined(underlineLinks(line, new Set())), "");
    assert.equal(underlined(underlineLinks(line, new Set([1]))), "");
});

test("underlineLinks underlines every character of the picked link only", (t) => {
    hyperlinks(t);
    const line = `go ${hyperlink(styled, URL_A)} now`;
    assert.equal(underlined(underlineLinks(line, FIRST)), "text");
    const plain = `go ${hyperlink("text", URL_A)} now`;
    assert.equal(underlined(underlineLinks(plain, FIRST)), "text");
    assert.equal(underlined(underlineLinks(plain)), "");
});

test("underlineLinks keeps underline on text outside links", (t) => {
    hyperlinks(t);
    const line = `\x1b[4mbefore\x1b[24m ${hyperlink("link", URL_A)} \x1b[4mafter\x1b[24m`;
    for (const picked of [undefined, FIRST]) {
        const actual = underlined(underlineLinks(line, picked));
        assert.equal(actual, picked ? "beforelinkafter" : "beforeafter");
    }
});

test("underlineLinks does not underline text after a picked link", (t) => {
    hyperlinks(t);
    const line = `${hyperlink("link", URL_A)} tail`;
    const output = cells(underlineLinks(line, FIRST));
    assert.equal(output.filter((c) => c.href === undefined && c.underline).length, 0);
});

test("underlineLinks handles each wrapped line of a link the same way", (t) => {
    hyperlinks(t);
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const lines = wrapTextWithAnsi(hyperlink(`${BLUE}\x1b[4m${text}\x1b[24m\x1b[39m`, URL_A), 20);
    assert.ok(lines.length > 1);
    for (const line of lines) {
        const visible = stripTerminalSequences(line);
        assert.equal(underlined(underlineLinks(line)), "");
        assert.equal(underlined(underlineLinks(line, FIRST)), visible);
    }
});

test("underlineLinks treats the 4 in 38;5;4 as a color, not underline", (t) => {
    hyperlinks(t);
    const line = hyperlink("\x1b[38;5;4mtext\x1b[39m", URL_A);
    assert.equal(underlined(line), "");
    assert.equal(underlined(underlineLinks(line)), "");
    assert.equal(underlined(underlineLinks(line, FIRST)), "text");
});

test("underlineLinks underlines only the picked ordinal among several links", (t) => {
    hyperlinks(t);
    const line = `${hyperlink(styled, URL_A)} ${hyperlink("other", URL_B)}`;
    assert.equal(underlined(underlineLinks(line, new Set([0]))), "text");
    assert.equal(underlined(underlineLinks(line, new Set([1]))), "other");
    assert.equal(underlined(underlineLinks(line, new Set([0, 1]))), "textother");
});

test("underlineLinks underlines by position, not by target", (t) => {
    hyperlinks(t);
    const line = `${hyperlink("one", URL_A)} ${hyperlink("two", URL_A)}`;
    assert.equal(underlined(underlineLinks(line, new Set([1]))), "two");
});

test("underlineLinks keeps visible text and link columns", (t) => {
    hyperlinks(t);
    const line = `ab ${hyperlink(styled, URL_A)} ${hyperlink("other", URL_B)} z`;
    for (const picked of [undefined, new Set([0]), new Set([1])]) {
        const output = underlineLinks(line, picked);
        assert.equal(stripTerminalSequences(output), stripTerminalSequences(line));
        for (let column = 0; column < 20; column++)
            assert.equal(getOsc8LinkAtColumn(output, column), getOsc8LinkAtColumn(line, column));
    }
    assert.equal(getOsc8LinkAtColumn(underlineLinks(line, FIRST), 4), URL_A);
});

test("findLinks returns nothing for a line without OSC 8", () => {
    assert.deepEqual(findLinks("plain \x1b[4mtext\x1b[24m"), []);
    assert.deepEqual(findLinks(""), []);
});

test("findLinks numbers the links on a row and reports their columns", (t) => {
    hyperlinks(t);
    const line = `go ${hyperlink("text", URL_A)} and ${hyperlink(styled, URL_B)} now`;
    const actual = findLinks(line).map(({ href, ordinal, start, end }) => ({
        href,
        ordinal,
        start,
        end,
    }));
    const expected = [
        { href: URL_A, ordinal: 0, start: 3, end: 7 },
        { href: URL_B, ordinal: 1, start: 12, end: 16 },
    ];
    assert.deepEqual(actual, expected);
});

test("findLinks counts a wide character as two columns", (t) => {
    hyperlinks(t);
    const [span] = findLinks(`中${hyperlink("文x", URL_A)}`);
    assert.equal(span?.start, 2);
    assert.equal(span?.end, 5);
});

test("findLinks marks a link at the row start as leading but not trailing before words", (t) => {
    hyperlinks(t);
    const [span] = findLinks(`${hyperlink("link", URL_A)} tail`);
    assert.equal(span?.leading, true);
    assert.equal(span?.trailing, false);
});

test("findLinks marks a link in the middle with words around it as neither", (t) => {
    hyperlinks(t);
    const [span] = findLinks(`head ${hyperlink("link", URL_A)} tail`);
    assert.equal(span?.leading, false);
    assert.equal(span?.trailing, false);
});

test("findLinks marks a link at the row end as trailing but not leading after words", (t) => {
    hyperlinks(t);
    const [span] = findLinks(`head ${hyperlink("link", URL_A)}`);
    assert.equal(span?.leading, false);
    assert.equal(span?.trailing, true);
});

test("findLinks ignores spaces, punctuation and styling around a link", (t) => {
    hyperlinks(t);
    const [span] = findLinks(`\x1b[2m > \x1b[22m${hyperlink("link", URL_A)} ...`);
    assert.equal(span?.leading, true);
    assert.equal(span?.trailing, true);
});

test("hoveredLinks picks only the link under the pointer, not the same target on other rows", (t) => {
    hyperlinks(t);
    const link = hyperlink("src/a.ts", URL_A);
    const lines = [`assistant: ${link}`, `tool call: read ${link}`, `user: ${link}`];
    const actual = hoveredLinks(lines, { row: 0, column: 12 });
    const expected = new Map([[0, new Set([0])]]);
    assert.deepEqual(actual, expected);
    // "tool call: read " and "user: " are 16 and 6 columns wide.
    for (const [row, column] of [
        [1, 17],
        [2, 7],
    ] as const) {
        const other = hoveredLinks(lines, { row, column });
        assert.deepEqual(other, new Map([[row, new Set([0])]]));
    }
});

test("hoveredLinks picks the right ordinal among several links on a row", (t) => {
    hyperlinks(t);
    const lines = [`${hyperlink("one", URL_A)} ${hyperlink("two", URL_B)}`];
    assert.deepEqual(hoveredLinks(lines, { row: 0, column: 5 }), new Map([[0, new Set([1])]]));
});

test("hoveredLinks picks every row of a link wrapped over three rows", (t) => {
    hyperlinks(t);
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const rows = wrapTextWithAnsi(hyperlink(`${BLUE}\x1b[4m${text}\x1b[24m\x1b[39m`, URL_A), 20);
    assert.equal(rows.length, 3);
    const lines = rows.map((row) => ` ${row}`);
    const expected = new Map([
        [0, new Set([0])],
        [1, new Set([0])],
        [2, new Set([0])],
    ]);
    for (let row = 0; row < lines.length; row++)
        assert.deepEqual(hoveredLinks(lines, { row, column: 2 }), expected);
});

test("hoveredLinks does not extend to an unrelated row with the same target", (t) => {
    hyperlinks(t);
    const text = "alpha beta gamma delta epsilon";
    const rows = wrapTextWithAnsi(hyperlink(text, URL_A), 20).map((row) => ` ${row}`);
    assert.equal(rows.length, 2);
    const lines = [...rows, `see ${hyperlink("alpha", URL_A)}`];
    const expected = new Map([
        [0, new Set([0])],
        [1, new Set([0])],
    ]);
    assert.deepEqual(hoveredLinks(lines, { row: 0, column: 2 }), expected);
    assert.deepEqual(hoveredLinks(lines, { row: 2, column: 5 }), new Map([[2, new Set([0])]]));
});

test("hoveredLinks picks nothing off a link, below the rows, or on a row without links", (t) => {
    hyperlinks(t);
    const lines = ["no link", `abc ${hyperlink("text", URL_A)} end`];
    assert.equal(hoveredLinks(lines, { row: 1, column: 0 }).size, 0);
    assert.equal(hoveredLinks(lines, { row: 1, column: 8 }).size, 0);
    assert.equal(hoveredLinks(lines, { row: 2, column: 5 }).size, 0);
    assert.equal(hoveredLinks(lines, { row: 0, column: 2 }).size, 0);
    assert.equal(hoveredLinks(lines, undefined).size, 0);
});

test("hoveredLinks treats both cells of a wide character as the character", (t) => {
    hyperlinks(t);
    const lines = [`中${hyperlink("文x", URL_A)}`];
    assert.equal(hoveredLinks(lines, { row: 0, column: 1 }).size, 0);
    for (const column of [2, 3, 4])
        assert.deepEqual(hoveredLinks(lines, { row: 0, column }), new Map([[0, new Set([0])]]));
    assert.equal(hoveredLinks(lines, { row: 0, column: 5 }).size, 0);
});

// A fake TUI whose default screen has a link "text" at row 2 (1-based), columns 5-8 (1-based).
function fakeTui(screen: string[] = ["no link", `abc ${hyperlink("text", URL_A)} end`]) {
    const calls = { input: [] as string[], resets: 0 };
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

test("installLinkHover repaints once on motion over a link and underlines only it", (t) => {
    hyperlinks(t);
    const { tui, calls, screen } = fakeTui();
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    assert.equal(tui.handleViewportInput(move(5, 2)), "handled");
    assert.equal(repaints, 1);
    assert.equal(frameUnderlined(tui, screen), "text");
    assert.equal(calls.input.length, 1);
});

test("installLinkHover does not repaint when the pointer moves inside the same link", (t) => {
    hyperlinks(t);
    const { tui, screen } = fakeTui();
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    tui.handleViewportInput(move(5, 2));
    tui.handleViewportInput(move(6, 2));
    tui.handleViewportInput(move(8, 2));
    assert.equal(repaints, 1);
    assert.equal(frameUnderlined(tui, screen), "text");
});

test("installLinkHover repaints when the pointer moves to another link", (t) => {
    hyperlinks(t);
    const screen = ["no link", `abc ${hyperlink("text", URL_A)} ${hyperlink("other", URL_B)}`];
    const { tui } = fakeTui(screen);
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    tui.handleViewportInput(move(5, 2));
    assert.equal(frameUnderlined(tui, screen), "text");
    tui.handleViewportInput(move(11, 2));
    assert.equal(repaints, 2);
    assert.equal(frameUnderlined(tui, screen), "other");
});

test("installLinkHover repaints when the pointer moves off all links", (t) => {
    hyperlinks(t);
    const { tui, screen } = fakeTui();
    let repaints = 0;
    installLinkHover(tui, () => repaints++);
    tui.handleViewportInput(move(5, 2));
    tui.handleViewportInput(move(1, 2));
    assert.equal(repaints, 2);
    assert.equal(frameUnderlined(tui, screen), "");
    tui.handleViewportInput(move(1, 1));
    assert.equal(repaints, 2);
});

test("installLinkHover keeps the hover on a wheel event", (t) => {
    hyperlinks(t);
    for (const code of [64, 65]) {
        const { tui, screen } = fakeTui();
        let repaints = 0;
        installLinkHover(tui, () => repaints++);
        tui.handleViewportInput(move(5, 2));
        tui.handleViewportInput(`\x1b[<${code};1;1M`);
        assert.equal(repaints, 1);
        assert.equal(frameUnderlined(tui, screen), "text");
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

test("installLinkHover underlines only the hovered row when rows share a target", (t) => {
    hyperlinks(t);
    const link = hyperlink("path", URL_A);
    const screen = [`assistant: ${link}`, `tool call: read ${link}`, `user: ${link}`];
    const { tui } = fakeTui(screen);
    installLinkHover(tui, () => {});
    tui.handleViewportInput(move(13, 1));
    const frame = tui.applyLineResets([...screen]);
    assert.deepEqual(frame.slice(0, 3).map(underlined), ["path", "", ""]);
    tui.handleViewportInput(move(18, 2));
    const next = tui.applyLineResets([...screen]);
    assert.deepEqual(next.slice(0, 3).map(underlined), ["", "path", ""]);
});

test("installLinkHover underlines the link under the pointer when lines change between frames", (t) => {
    hyperlinks(t);
    const { tui, screen } = fakeTui();
    installLinkHover(tui, () => {});
    tui.handleViewportInput(move(5, 2));
    assert.equal(frameUnderlined(tui, screen), "text");
    const plain = ["no link", "abc plain end"];
    assert.equal(frameUnderlined(tui, plain), "");
    const moved = ["no link", `${hyperlink("other", URL_B)} x`];
    assert.equal(frameUnderlined(tui, moved), "other");
});

test("installLinkHover passes every input to the original unchanged", (t) => {
    hyperlinks(t);
    const { tui, calls } = fakeTui();
    installLinkHover(tui, () => {});
    const inputs = ["a", "\x1b[A", move(5, 2), "\x1b[<64;1;1M", move(5, 2, 32), move(5, 2, 0)];
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
