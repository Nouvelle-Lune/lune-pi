import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
    getThemeByName,
    setThemeInstance,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { fileHref, linkText } from "../src/utils/links.ts";
import { transformMarkdown } from "../src/renderer/markdown-enhance.ts";
import { toolHref } from "../src/renderer/tool/summary.ts";
import { renderToolLine } from "../src/renderer/tool/presentation.ts";
import { outputPreview } from "../src/renderer/tool/output.ts";

function hyperlinks(t: TestContext, enabled: boolean) {
    const previous = getCapabilities();
    setCapabilities({ ...previous, hyperlinks: enabled });
    t.after(() => setCapabilities(previous));
}

function workspace(t: TestContext) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lune-links-")));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, url: (relative: string) => pathToFileURL(join(dir, relative)).href };
}

function inDirectory(t: TestContext, dir: string) {
    const original = process.cwd();
    process.chdir(dir);
    t.after(() => process.chdir(original));
}

const markdown = (
    text: string,
    messageType: "user" | "assistant" | "assistant-thinking" = "assistant",
) => transformMarkdown(text, { messageType, isStreaming: false, availableWidth: 80 });

test("fileHref links existing files and directories and drops location suffixes", (t) => {
    const { dir, url } = workspace(t);
    assert.equal(fileHref("src/a.ts", dir), url("src/a.ts"));
    assert.equal(fileHref(join(dir, "src/a.ts"), dir), url("src/a.ts"));
    assert.equal(fileHref("src", dir), url("src"));
    assert.equal(fileHref("src/a.ts:12", dir), url("src/a.ts"));
    assert.equal(fileHref("src/a.ts:12:4", dir), url("src/a.ts"));
    assert.equal(fileHref("README.md#install", dir), url("README.md"));
});

test("fileHref resolves ~/ from the home directory", (t) => {
    const { dir, url } = workspace(t);
    const previous = process.env.HOME;
    process.env.HOME = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
    });
    assert.equal(fileHref("~/README.md", join(dir, "src")), url("README.md"));
    assert.equal(fileHref("~/missing.md", dir), undefined);
});

test("fileHref rejects missing paths and targets without a word character", (t) => {
    const { dir } = workspace(t);
    assert.equal(fileHref("src/missing.ts", dir), undefined);
    assert.equal(fileHref("/", dir), undefined);
});

test("linkText wraps URLs and existing paths while trailing punctuation stays outside", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    const actual = linkText("see https://example.com/a, and src/a.ts.", dir);
    const expected = `see ${hyperlink("https://example.com/a", "https://example.com/a")}, and ${hyperlink("src/a.ts", url("src/a.ts"))}.`;
    assert.equal(actual, expected);
});

test("linkText keeps :line:col visible but out of the href", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    const actual = linkText("at src/a.ts:3:7 now", dir);
    const expected = `at ${hyperlink("src/a.ts:3:7", url("src/a.ts"))} now`;
    assert.equal(actual, expected);
});

test("linkText leaves missing paths and git remotes unchanged", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    const text = "src/missing.ts and git@github.com:owner/repo";
    assert.equal(linkText(text, dir), text);
});

test("linkText leaves text unchanged when hyperlinks are off", (t) => {
    hyperlinks(t, false);
    const { dir } = workspace(t);
    const text = "https://example.com and src/a.ts";
    assert.equal(linkText(text, dir), text);
});

test("transformMarkdown with hyperlinks off only turns bare URLs into links", (t) => {
    hyperlinks(t, false);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const actual = markdown(
        "Open https://example.com/x, `src/a.ts` and src/a.ts and [a](src/a.ts)",
    );
    const expected =
        "Open [https://example.com/x](https://example.com/x), `src/a.ts` and src/a.ts and [a](src/a.ts)";
    assert.equal(actual, expected);
});

test("transformMarkdown links inline code that names an existing path", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    const actual = markdown("Edit `src/a.ts:3` please");
    const expected = `Edit [\`src/a.ts:3\`](<${url("src/a.ts")}>) please`;
    assert.equal(actual, expected);
});

test("transformMarkdown links a bare path in prose", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    const actual = markdown("Look at src/a.ts for details");
    const expected = `Look at [src/a.ts](<${url("src/a.ts")}>) for details`;
    assert.equal(actual, expected);
});

test("transformMarkdown gives Markdown links to local paths a file target", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    assert.equal(markdown("[rel](src/a.ts:42)"), `[rel](<${url("src/a.ts")}>)`);
    assert.equal(markdown(`[abs](${join(dir, "README.md")}#top)`), `[abs](<${url("README.md")}>)`);
});

test("transformMarkdown leaves images, web links, code blocks and non-paths unchanged", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const unchanged = [
        "![img](src/a.ts)",
        "[web](https://example.com/a)",
        "[mail](mailto:me@example.com)",
        "```\nsrc/a.ts\n```",
        "`src/missing.ts`",
        "missing src/missing.ts here",
        "`npm run build`",
        "`config.mode`",
    ];
    for (const text of unchanged) assert.equal(markdown(text), text);
});

test("transformMarkdown does not touch assistant-thinking messages", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const text = "Check src/a.ts and https://example.com";
    assert.equal(markdown(text, "assistant-thinking"), text);
});

test("toolHref links path tools and skips pattern, command and codemode summaries", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    for (const name of ["read", "edit", "write", "ls"])
        assert.equal(toolHref(name, { path: "src/a.ts" }, dir), url("src/a.ts"));
    assert.equal(toolHref("grep", { pattern: "x", path: "src" }, dir), undefined);
    assert.equal(toolHref("find", { pattern: "*.ts", path: "src" }, dir), undefined);
    assert.equal(toolHref("bash", { command: "ls src" }, dir), undefined);
    assert.equal(toolHref("codemode", { path: "src" }, dir), undefined);
});

test("toolHref is undefined when hyperlinks are off", (t) => {
    hyperlinks(t, false);
    const { dir } = workspace(t);
    assert.equal(toolHref("read", { path: "src/a.ts" }, dir), undefined);
});

test("renderToolLine wraps the clipped summary in the link without changing width", (t) => {
    hyperlinks(t, true);
    initTheme("dark");
    const theme = getThemeByName("dark")!;
    setThemeInstance(theme);
    const { url } = workspace(t);
    const call = { name: "read", summary: "src/a.ts", status: "done" as const };
    const plain = renderToolLine(theme, 60, call);
    const linked = renderToolLine(theme, 60, { ...call, href: url("src/a.ts") });
    assert.ok(linked.includes(`\x1b]8;;${url("src/a.ts")}\x1b\\`));
    assert.ok(linked.includes("\x1b]8;;\x1b\\"));
    assert.equal(visibleWidth(linked), visibleWidth(plain));
    const clipped = renderToolLine(theme, 24, {
        ...call,
        summary: "src/a/very/long/clipped.ts",
        href: url("src/a.ts"),
    });
    assert.equal(clipped.split("\x1b]8;;").length, 3);
});

test("outputPreview links URLs and existing paths in tool output", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    const preview = outputPreview(
        "error at src/a.ts:3 see https://example.com/doc",
        80,
        5,
        false,
        dir,
    );
    const actual = preview.lines.join("\n");
    assert.ok(actual.includes(hyperlink("src/a.ts:3", url("src/a.ts"))));
    assert.ok(actual.includes(hyperlink("https://example.com/doc", "https://example.com/doc")));
});

test("outputPreview keeps the same href on every row of a wrapped URL", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    const href = `https://example.com/${"a".repeat(60)}`;
    const preview = outputPreview(href, 20, 10, false, dir);
    assert.ok(preview.lines.length > 1);
    for (const row of preview.lines) assert.ok(row.includes(`\x1b]8;;${href}\x1b\\`), row);
});
