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
import { nestedHref } from "../src/renderer/tool/activity.ts";
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

// Each remote-looking string also exists as a local path, so accepting the string as a path
// instead of rejecting its remote or network syntax would produce a link.
function remoteCollisions(t: TestContext) {
    const { dir, url } = workspace(t);
    const scheme = "https://example.com/a.ts";
    mkdirSync(join(dir, "https:", "example.com"), { recursive: true });
    writeFileSync(join(dir, "https:", "example.com", "a.ts"), "remote collision\n");
    const scp = "git@host:owner/repo.ts";
    mkdirSync(join(dir, "git@host:owner"), { recursive: true });
    writeFileSync(join(dir, "git@host:owner", "repo.ts"), "remote collision\n");
    const unc = String.raw`\\server\share\repo.ts`;
    writeFileSync(join(dir, unc), "remote collision\n");
    const network = `//${join(dir, "src/a.ts").slice(1)}`;
    return { dir, url, scheme, scp, unc, network };
}

const markdown = (
    text: string,
    messageType: "user" | "assistant" | "assistant-thinking" = "assistant",
    isStreaming = false,
) => transformMarkdown(text, { messageType, isStreaming, availableWidth: 80 });

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

test("fileHref rejects remote and network targets even when a local collision exists", (t) => {
    const { dir, url, scheme, scp, unc, network } = remoteCollisions(t);
    for (const target of [scheme, scp, unc, network])
        assert.equal(fileHref(target, dir), undefined, target);
    assert.equal(fileHref(join(dir, "src/a.ts"), dir), url("src/a.ts"));
});

test("linkText links URLs while trailing punctuation stays outside", (t) => {
    hyperlinks(t, true);
    const actual = linkText("see https://example.com/a, and src/a.ts.");
    const expected = `see ${hyperlink("https://example.com/a", "https://example.com/a")}, and src/a.ts.`;
    assert.equal(actual, expected);
});

test("linkText leaves existing, missing and remote targets unchanged", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const text = String.raw`src/a.ts and src/missing.ts and git@github.com:owner/repo and ssh://git@host/repo and //server/share/file and \\server\share\file`;
    assert.equal(linkText(text), text);
});

test("linkText leaves text unchanged when hyperlinks are off", (t) => {
    hyperlinks(t, false);
    const text = "https://example.com and src/a.ts";
    assert.equal(linkText(text), text);
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

test("transformMarkdown links explicit inline code for files and directories outside cwd", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lune-links-outside-")));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const file = join(outside, "artifact.log");
    writeFileSync(file, "log\n");
    const actual = markdown(`See \`${file}:12\` and \`${outside}\`.`);
    const expected = `See [\`${file}:12\`](<${pathToFileURL(file).href}>) and [\`${outside}\`](<${pathToFileURL(outside).href}>).`;
    assert.equal(actual, expected);
});

test("transformMarkdown links URLs while leaving a bare existing path in prose unlinked", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const actual = markdown("Open https://example.com/a, then src/a.ts.");
    const expected = "Open [https://example.com/a](https://example.com/a), then src/a.ts.";
    assert.equal(actual, expected);
});

test("transformMarkdown leaves source, commands, diffs, logs and stacks unlinked", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const unchanged = [
        'import { helper } from "./src/a.ts";',
        "Run npm run build --prefix ./src from the repository root.",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "    at load (src/a.ts:3:7)",
        "[info] wrote src/a.ts",
        "src/a.ts",
        "README.md",
        "`cat src/a.ts`",
        '`const helper = "./src/a.ts";`',
    ];
    for (const text of unchanged) assert.equal(markdown(text), text, text);
});

test("transformMarkdown links a path created after an earlier miss", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    assert.equal(markdown("Write `notes.txt` next"), "Write `notes.txt` next");
    writeFileSync(join(dir, "notes.txt"), "notes\n");
    const actual = markdown("Write `notes.txt` next");
    const expected = `Write [\`notes.txt\`](<${url("notes.txt")}>) next`;
    assert.equal(actual, expected);
});

test("transformMarkdown leaves remote and network references in code and links unlinked", (t) => {
    hyperlinks(t, true);
    const { dir, scheme, scp, unc, network } = remoteCollisions(t);
    inDirectory(t, dir);
    const unchanged = [
        `See \`${scheme}\` and \`${scp}\`.`,
        `[share](${unc})`,
        `[path](${network})`,
    ];
    for (const text of unchanged) assert.equal(markdown(text), text, text);
});

test("transformMarkdown links complete inline code paths with spaces and parentheses", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    writeFileSync(join(dir, "src", "my file.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "a(b).ts"), "export {};\n");
    const actual = markdown("See `src/my file.ts:2` and `src/a(b).ts`.");
    const expected = `See [\`src/my file.ts:2\`](<${url("src/my file.ts")}>) and [\`src/a(b).ts\`](<${url("src/a(b).ts")}>).`;
    assert.equal(actual, expected);
});

test("transformMarkdown preserves an explicit Markdown link to a missing path", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const text = "[label](missing.ts)";
    assert.equal(markdown(text), text);
});

test("transformMarkdown and toolHref link explicit extensionless file targets", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    inDirectory(t, dir);
    writeFileSync(join(dir, "Makefile"), "all:\n");
    assert.equal(markdown("[build](Makefile:12)"), `[build](<${url("Makefile")}>)`);
    assert.equal(markdown("Edit `./Makefile:3`"), `Edit [\`./Makefile:3\`](<${url("Makefile")}>)`);
    assert.equal(toolHref("read", { path: "Makefile:12" }, dir), url("Makefile"));
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

test("transformMarkdown leaves streaming messages unlinked", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const text = "Edit `src/a.ts` and see https://example.com";
    assert.equal(markdown(text, "assistant", true), text);
});

test("toolHref links path tools and skips pattern, command and codemode summaries", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    for (const name of ["read", "edit", "write", "ls"])
        assert.equal(toolHref(name, { path: "src/a.ts" }, dir), url("src/a.ts"));
    assert.equal(toolHref("ls", { path: "src" }, dir), url("src"));
    assert.equal(toolHref("write", { file_path: "README.md" }, dir), url("README.md"));
    assert.equal(
        toolHref("read", { path: join(dir, "README.md") }, join(dir, "src")),
        url("README.md"),
    );
    assert.equal(toolHref("grep", { pattern: "x", path: "src" }, dir), undefined);
    assert.equal(toolHref("find", { pattern: "*.ts", path: "src" }, dir), undefined);
    assert.equal(toolHref("bash", { command: "ls src" }, dir), undefined);
    assert.equal(toolHref("codemode", { path: "src" }, dir), undefined);
});

test("nestedHref links a nested path target and skips nested commands and searches", (t) => {
    hyperlinks(t, true);
    const { dir, url } = workspace(t);
    const done = "done" as const;
    assert.equal(
        nestedHref({ name: "read", args: { path: "src/a.ts" }, status: done }, dir),
        url("src/a.ts"),
    );
    assert.equal(
        nestedHref({ name: "write", args: { file_path: "README.md" }, status: done }, dir),
        url("README.md"),
    );
    assert.equal(
        nestedHref({ name: "bash", args: { command: "cat src/a.ts" }, status: done }, dir),
        undefined,
    );
    assert.equal(
        nestedHref({ name: "grep", args: { pattern: "x", path: "src" }, status: done }, dir),
        undefined,
    );
});

test("toolHref and nestedHref leave remote and network targets unlinked despite local collisions", (t) => {
    hyperlinks(t, true);
    const { dir, scheme, scp, unc, network } = remoteCollisions(t);
    for (const target of [scheme, scp, unc, network])
        assert.equal(toolHref("read", { path: target }, dir), undefined, target);
    assert.equal(
        nestedHref({ name: "read", args: { path: network }, status: "done" }, dir),
        undefined,
    );
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

test("outputPreview links URLs and leaves tool output paths unlinked", (t) => {
    hyperlinks(t, true);
    const { dir } = workspace(t);
    inDirectory(t, dir);
    const text = [
        'import { value } from "./src/a.ts";',
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "+export const value = 2;",
        "Error: boom",
        "    at load (src/a.ts:3:7)",
        "[info] wrote src/a.ts",
        "src/a.ts",
        "README.md",
        "see https://example.com/doc.",
    ].join("\n");
    const preview = outputPreview(text, 200, 20, false);
    const actual = preview.lines.join("\n");
    assert.equal(actual.includes("file://"), false, actual);
    assert.match(actual, /at load \(src\/a\.ts:3:7\)/);
    assert.ok(actual.includes(hyperlink("https://example.com/doc", "https://example.com/doc")));
});

test("outputPreview keeps the same href on every row of a wrapped URL", (t) => {
    hyperlinks(t, true);
    const href = `https://example.com/${"a".repeat(60)}`;
    const preview = outputPreview(href, 20, 10, false);
    assert.ok(preview.lines.length > 1);
    for (const row of preview.lines) assert.ok(row.includes(`\x1b]8;;${href}\x1b\\`), row);
});
