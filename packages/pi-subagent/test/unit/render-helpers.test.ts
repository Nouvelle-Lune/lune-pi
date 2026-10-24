import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
    BODY_TOP,
    assembleFrame,
    cell,
    listWindowStart,
    paintScrollbar,
    pad,
    paneGeometry,
} from "../../src/inspector/layout.ts";
import { Viewport } from "../../src/inspector/viewport.ts";
import { bandRow, clipToWidth, displayLines } from "../../src/render/text.ts";
import { fakeTheme } from "./support.ts";

test("a viewport follows the newest rows until the user scrolls up", () => {
    const viewport = new Viewport();

    assert.deepEqual(viewport.window(100, 10), { start: 90, newestHidden: 0 });
    assert.equal(viewport.scrollBy(-5), true);
    assert.equal(viewport.paused, true);

    // New rows arrive while the user reads: the first visible row stays.
    assert.deepEqual(viewport.window(120, 10), { start: 85, newestHidden: 25 });
});

test("scrolling back to the newest rows follows again; scrolling down while following is a no-op", () => {
    const viewport = new Viewport();

    viewport.window(100, 10);

    assert.equal(viewport.scrollBy(3), false);

    viewport.scrollBy(-2);

    assert.equal(viewport.scrollBy(2), true);
    assert.equal(viewport.paused, false);
});

test("jumpToOldest anchors at row 0 and follow releases it", () => {
    const viewport = new Viewport();

    viewport.window(50, 10);
    viewport.jumpToOldest();

    assert.deepEqual(viewport.window(50, 10), { start: 0, newestHidden: 40 });

    viewport.follow();

    assert.deepEqual(viewport.window(50, 10), { start: 40, newestHidden: 0 });
});

test("scrolling clamps at the oldest row and a short transcript never scrolls", () => {
    const viewport = new Viewport();

    viewport.window(100, 10);
    viewport.scrollBy(-1000);

    assert.deepEqual(viewport.window(100, 10), { start: 0, newestHidden: 90 });
    assert.equal(viewport.scrollBy(-1), false);

    const short = new Viewport();

    assert.deepEqual(short.window(3, 10), { start: 0, newestHidden: 0 });
    assert.equal(short.scrollBy(-1), false);
});

test("pane geometry keeps both panes above their minimum and the body within limits", () => {
    const wide = paneGeometry(200, 60);
    const narrow = paneGeometry(40, 10);

    assert.equal(wide.leftWidth, 36);
    assert.equal(wide.leftWidth + wide.rightWidth + 1, wide.innerWidth);
    assert.equal(wide.bodyHeight, 32);
    assert.equal(wide.rightStart, wide.leftWidth + 2);
    assert.ok(narrow.leftWidth >= 22);
    assert.ok(narrow.rightWidth >= 32);
    assert.equal(narrow.bodyHeight, 8);
});

test("the list window centres the selection until the list runs out", () => {
    assert.equal(listWindowStart(0, 20, 6), 0);
    assert.equal(listWindowStart(10, 20, 6), 7);
    assert.equal(listWindowStart(19, 20, 6), 14);
    assert.equal(listWindowStart(2, 3, 6), 0);
});

test("cell pads one column on each side and truncates; pad fills to the width", () => {
    assert.equal(cell("abc", 10), " abc      ");
    assert.equal(visibleWidth(cell("a very long text", 10)), 10);
    assert.equal(pad("ab", 5), "ab   ");
    assert.equal(pad("abcdef", 3), "abcdef");
});

test("assembleFrame draws a bordered frame with every line at the same width", () => {
    const geometry = paneGeometry(100, 40);
    const frame = assembleFrame(fakeTheme(), geometry, {
        header: "Header",
        left: ["L1"],
        right: ["R1"],
        footer: "Footer",
    });

    assert.equal(frame.length, BODY_TOP + geometry.bodyHeight + 3);
    assert.ok(frame.every((line) => visibleWidth(line) === geometry.innerWidth + 2));
    assert.match(frame[1]!, /Header/);
    assert.match(frame[BODY_TOP]!, /L1/);
    assert.match(frame[BODY_TOP]!, /R1/);
});

test("the scrollbar thumb tracks the window and a transcript that fits has none", () => {
    const theme = fakeTheme({ tag: true });
    const rows = Array.from({ length: 10 }, () => "text ");

    assert.deepEqual(paintScrollbar(theme, rows, 0, 10, 10), rows);

    const top = paintScrollbar(theme, rows, 0, 10, 100);
    const bottom = paintScrollbar(theme, rows, 90, 10, 100);

    assert.match(top[0]!, /<scrollbarThumb:┃>$/);
    assert.match(top[9]!, /<scrollbarTrack:│>$/);
    assert.match(bottom[0]!, /<scrollbarTrack:│>$/);
    assert.match(bottom[9]!, /<scrollbarThumb:┃>$/);
});

test("clipToWidth leaves fitting text, clips with an ellipsis, and handles tiny widths", () => {
    assert.equal(clipToWidth("short", 10), "short");
    assert.equal(clipToWidth("0123456789", 5), "0123…");
    assert.equal(clipToWidth("abc", 1), "…");
    assert.equal(clipToWidth("abc", 0), "");
});

test("displayLines strips terminal sequences, keeps what a carriage return leaves, expands tabs", () => {
    const actual = displayLines("\u001b[31mred\u001b[0m\nprogress 10%\rprogress 100%\n\ta\n");
    const expected = ["red", "progress 100%", "   a", ""];

    assert.deepEqual(actual, expected);
});

test("bandRow pads a row to the inner width inside side margins", () => {
    const row = bandRow(fakeTheme({ tag: true }), "toolSuccessBg", "ab", 6, 1);

    assert.equal(row, "[toolSuccessBg: ab     ]");
});
