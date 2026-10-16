import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    getThemeByName,
    setThemeInstance,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { config, DEFAULT_CONFIG, setConfig } from "../src/config/config.ts";
import {
    LUNE_THEME_RENDERER,
    publishThemeRenderer,
    type LuneActivity,
    type LuneActivityEntry,
    type LuneThemeRenderer,
} from "../src/protocol.ts";
import { ActivityCard } from "../src/renderer/activity-card.ts";
import { attentionCounts, callCounts } from "../src/renderer/tool/presentation.ts";

const globals = globalThis as Record<symbol, unknown>;

function renderer(): LuneThemeRenderer {
    return {
        version: 1,
        renderActivity: () => ({ render: () => [], invalidate() {} }),
    };
}

function protocolFixture(t: TestContext) {
    // Another test file in the same process may leave a host mounted; start from a clean slate.
    const previous = Object.getOwnPropertyDescriptor(globals, LUNE_THEME_RENDERER);
    delete globals[LUNE_THEME_RENDERER];
    t.after(() => {
        delete globals[LUNE_THEME_RENDERER];
        if (previous) Object.defineProperty(globals, LUNE_THEME_RENDERER, previous);
    });
}

test("the published renderer is found under the shared symbol and the release removes it", (t) => {
    protocolFixture(t);
    const published = renderer();

    const release = publishThemeRenderer(published);
    const whilePublished = globals[LUNE_THEME_RENDERER];
    release();

    assert.equal(LUNE_THEME_RENDERER, Symbol.for("@lune_99/pi-core-theme/renderer/v1"));
    assert.equal(whilePublished, published);
    assert.equal(LUNE_THEME_RENDERER in globals, false);
});

test("an older release leaves a newer publisher in place and is safe to call twice", (t) => {
    protocolFixture(t);
    const older = renderer();
    const newer = renderer();
    const releaseOlder = publishThemeRenderer(older);
    const releaseNewer = publishThemeRenderer(newer);

    releaseOlder();
    releaseOlder();
    const afterOlderRelease = globals[LUNE_THEME_RENDERER];
    releaseNewer();

    assert.equal(afterOlderRelease, newer);
    assert.equal(LUNE_THEME_RENDERER in globals, false);
});

test("a stale release does not remove a renderer published again after it was released", (t) => {
    protocolFixture(t);
    const first = renderer();
    const second = renderer();
    const releaseFirst = publishThemeRenderer(first);
    releaseFirst();
    const releaseSecond = publishThemeRenderer(second);

    releaseFirst();

    assert.equal(globals[LUNE_THEME_RENDERER], second);
    releaseSecond();
    assert.equal(LUNE_THEME_RENDERER in globals, false);
});

const EXPAND = "ctrl+o";
let entryCount = 0;
function cardFixture(t: TestContext, previewLines = 3) {
    const previous = { ...config, excludeRenderers: [...config.excludeRenderers] };
    initTheme("dark");
    const theme = getThemeByName("dark")!;
    setThemeInstance(theme);
    setConfig({ ...DEFAULT_CONFIG, mode: "on", previewLines });
    t.after(() => setConfig(previous));
    return theme;
}

function activity(entries: LuneActivityEntry[], extra: Partial<LuneActivity> = {}): LuneActivity {
    return { title: "Agents", entries, ...extra };
}
function entry(overrides: Partial<LuneActivityEntry> = {}): LuneActivityEntry {
    return { name: `tool${entryCount++}`, status: "done", ...overrides };
}
function numbered(count: number) {
    return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}
function card(theme: Theme, value: LuneActivity, expanded: boolean, key = () => EXPAND) {
    return new ActivityCard(value, expanded, theme, key);
}
function plain(rows: string[]) {
    return rows.map(stripVTControlCharacters);
}

test("collapsed header joins the summary with only non-zero attention counts", (t) => {
    const theme = cardFixture(t);
    const value = activity(
        [
            entry({ status: "running" }),
            entry({ status: "running" }),
            entry({ status: "failed" }),
            entry({ status: "cancelled" }),
            entry({ status: "done" }),
        ],
        { summary: "5 tasks" },
    );

    const actual = plain(card(theme, value, false).render(120))[0];

    assert.equal(actual, "● Agents  5 tasks · 2 running · 1 failed · 1 cancelled");
});

test("the header has no trailing separator when nothing needs attention and no summary is given", (t) => {
    const theme = cardFixture(t);
    const value = activity([entry(), entry({ status: "done" })]);

    const actual = plain(card(theme, value, false).render(120))[0];

    assert.equal(actual, "● Agents");
});

test("collapsed rows are indented three columns and use a closing branch for the last entry", (t) => {
    const theme = cardFixture(t);
    const value = activity([
        entry({ name: "first", summary: "alpha", durationMs: 1200 }),
        entry({ name: "second", status: "failed", detail: "exit 1" }),
        entry({ name: "third", status: "cancelled" }),
    ]);

    const actual = plain(card(theme, value, false).render(120));

    const expected = [
        "● Agents  1 failed · 1 cancelled",
        "   ├ ● first  alpha · 1.2s",
        "   ├ ● second · failed · exit 1",
        "   └ ○ third · cancelled",
    ];
    assert.deepEqual(actual, expected);
});

test("collapsed output keeps the last preview lines and reports how many earlier lines are hidden", (t) => {
    const theme = cardFixture(t, 3);
    const value = activity([entry({ name: "run", output: numbered(5) })]);

    const actual = plain(card(theme, value, false).render(120));

    const expected = [
        "● Agents",
        "   └ ● run",
        "       line 3",
        "       line 4",
        "       line 5",
        "       … 2 earlier lines · ctrl+o to expand",
    ];
    assert.deepEqual(actual, expected);
});

test("the hidden-line hint is singular for one earlier line and absent when everything fits", (t) => {
    const theme = cardFixture(t, 3);
    const oneHidden = activity([entry({ output: numbered(4) })]);
    const fits = activity([entry({ output: numbered(3) })]);

    const hint = plain(card(theme, oneHidden, false).render(120)).at(-1);
    const fitting = plain(card(theme, fits, false).render(120)).join("\n");

    assert.equal(hint, "       … 1 earlier line · ctrl+o to expand");
    assert.doesNotMatch(fitting, /…|to expand/);
});

test("with no preview lines the hint counts all lines without saying earlier", (t) => {
    const theme = cardFixture(t, 0);
    const many = activity([entry({ name: "run", output: numbered(4) })]);
    const single = activity([entry({ name: "run", output: "only" })]);

    const manyRows = plain(card(theme, many, false).render(120));
    const singleRows = plain(card(theme, single, false).render(120));

    assert.deepEqual(manyRows.slice(2), ["       … 4 lines · ctrl+o to expand"]);
    assert.deepEqual(singleRows.slice(2), ["       … 1 line · ctrl+o to expand"]);
});

test("the hint names the key supplied by the caller each time it renders", (t) => {
    const theme = cardFixture(t, 0);
    let key = "ctrl+o";
    const value = activity([entry({ output: "text" })]);
    const first = card(theme, value, false, () => key);
    const before = plain(first.render(120)).at(-1);

    key = "alt+e";
    first.invalidate();
    const after = plain(first.render(120)).at(-1);

    assert.equal(before, "       … 1 line · ctrl+o to expand");
    assert.equal(after, "       … 1 line · alt+e to expand");
});

test("output wrapped by a narrow width counts wrapped lines and keeps the wrapped tail", (t) => {
    const theme = cardFixture(t, 2);
    // Body width is 50 - 3 - 4 = 43 columns, so the 90 characters wrap onto three lines.
    const value = activity([entry({ output: `${"a".repeat(43)}${"b".repeat(43)}cccc` })]);

    const actual = plain(card(theme, value, false).render(50));

    const expected = [
        "● Agents",
        `   └ ● ${value.entries[0]!.name}`,
        `       ${"b".repeat(43)}`,
        "       cccc",
        "       … 1 earlier line · ctrl+o to expand",
    ];
    assert.deepEqual(actual, expected);
});

test("errors are shown under their row in the error colour ahead of the output, even without preview lines", (t) => {
    const theme = cardFixture(t, 0);
    const value = activity([
        entry({ name: "broken", status: "failed", error: "boom\nsecond", output: "tail" }),
    ]);

    const rendered = card(theme, value, false).render(120);

    const actual = plain(rendered);
    assert.deepEqual(actual, [
        "● Agents  1 failed",
        "   └ ● broken · failed",
        "       boom",
        "       second",
        "       … 1 line · ctrl+o to expand",
    ]);
    assert.ok(rendered[2]!.includes(theme.fg("error", "boom")));
    assert.ok(rendered[3]!.includes(theme.fg("error", "second")));
});

test("preview output uses the tool output colour and the hint uses the dim colour", (t) => {
    const theme = cardFixture(t, 1);
    const value = activity([entry({ output: "one\ntwo" })]);

    const rendered = card(theme, value, false).render(120);

    assert.ok(rendered[2]!.includes(theme.fg("toolOutput", "two")));
    assert.ok(rendered[3]!.includes(theme.fg("dim", "… 1 earlier line · ctrl+o to expand")));
});

test("terminal control sequences and trailing blank lines are stripped from output", (t) => {
    const theme = cardFixture(t, 5);
    const value = activity([entry({ output: "\x1b[31mred\x1b[0m\r\nnext\n\n" })]);

    const actual = plain(card(theme, value, false).render(120)).slice(2);

    assert.deepEqual(actual, ["       red", "       next"]);
});

test("expanded cards show every output line without a hint and frame every row", (t) => {
    const theme = cardFixture(t, 2);
    const value = activity([entry({ name: "run", output: numbered(6), error: "bad" })], {
        summary: "1 task",
    });

    const rows = plain(card(theme, value, true).render(40));

    const expected = [
        "● Agents  1 task",
        "└ ● run",
        "    bad",
        ...Array.from({ length: 6 }, (_, index) => `    line ${index + 1}`),
    ].map((row) => `│ ${row.padEnd(37)} `);
    assert.deepEqual(rows, expected);
});

test("expanded cards keep tree branches for several entries", (t) => {
    const theme = cardFixture(t);
    const value = activity([entry({ name: "a" }), entry({ name: "b" })]);

    const actual = plain(card(theme, value, true).render(30)).map((row) => row.trimEnd());

    assert.deepEqual(actual, ["│ ● Agents", "│ ├ ● a", "│ └ ● b"]);
});

test("rendered rows never exceed the width, including wide characters, at narrow and normal widths", (t) => {
    const theme = cardFixture(t, 3);
    const value = activity(
        [
            entry({
                name: "运行命令",
                summary: "一个很长的说明 ".repeat(8),
                status: "failed",
                detail: "exit 127",
                durationMs: 65_000,
                error: "错误信息 ".repeat(6),
                output: `${"x".repeat(90)}\n${"宽字符".repeat(20)}\n${numbered(8)}`,
            }),
            entry({ name: "second-with-a-very-long-name", status: "running" }),
            entry({ status: "cancelled", summary: "tail" }),
        ],
        { title: "A deliberately long activity title", summary: "3 tasks in total" },
    );
    const widths = [...Array.from({ length: 20 }, (_, index) => index + 1), 30, 40, 80, 120];

    for (const expanded of [false, true]) {
        for (const width of widths) {
            const rows = card(theme, value, expanded).render(width);
            for (const row of rows)
                assert.ok(
                    visibleWidth(row) <= width,
                    `expanded=${expanded} width=${width}: ${JSON.stringify(stripVTControlCharacters(row))} is ${visibleWidth(row)} columns`,
                );
        }
    }
});

test("an activity without entries renders only its heading", (t) => {
    const theme = cardFixture(t);

    const actual = plain(card(theme, activity([], { title: "Idle" }), false).render(80));

    assert.equal(actual.length, 1);
    assert.match(actual[0]!, /^. Idle/);
});

test("repeated renders at the same width reuse the lines until invalidated or configuration changes", (t) => {
    const theme = cardFixture(t, 3);
    const subject = card(theme, activity([entry({ output: numbered(6) })]), false);

    const first = subject.render(80);
    const second = subject.render(80);
    const otherWidth = subject.render(60);
    const sameWidthAgain = subject.render(80);
    subject.invalidate();
    const afterInvalidate = subject.render(80);
    setConfig({ ...config, previewLines: 1 });
    const afterConfig = subject.render(80);

    assert.equal(second, first);
    assert.notEqual(otherWidth, first);
    assert.notEqual(sameWidthAgain, first);
    assert.notEqual(afterInvalidate, sameWidthAgain);
    assert.deepEqual(afterInvalidate, sameWidthAgain);
    assert.equal(plain(afterConfig).filter((row) => /line \d/.test(row)).length, 1);
});

test("attention counts list only running, failed and cancelled calls, and call counts lead with the total", (t) => {
    const theme = cardFixture(t);
    const statuses = ["done", "running", "failed", "failed", "cancelled", "done"] as const;
    const settled = ["done", "done"] as const;

    const attention = plain(attentionCounts(theme, statuses)).filter(Boolean);
    const settledAttention = plain(attentionCounts(theme, settled)).filter(Boolean);
    const totals = plain([callCounts(theme, statuses), callCounts(theme, ["done"])]);

    assert.deepEqual(attention, ["1 running", "2 failed", "1 cancelled"]);
    assert.deepEqual(settledAttention, []);
    assert.deepEqual(totals, ["6 calls · 1 running · 2 failed · 1 cancelled", "1 call"]);
});
