import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
    ToolExecutionComponent,
    createReadToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createBashToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createPowerShellToolDefinition,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionToolContext,
    type ToolDefinition,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Markdown,
    Text,
    TuiAltScreen,
    type Terminal,
    visibleWidth,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
    getThemeByName,
    setThemeInstance,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ThinkingAnimation, THINKING_FRAME_MS } from "../src/renderer/thinking-animation.ts";
import { commandSummary, fitSummary } from "../src/renderer/tool/summary.ts";
import { framedRow } from "../src/renderer/cards.ts";
import { richDiffSummary } from "../src/renderer/tool/diff/index.ts";
import {
    createWriteMetadataAdapter,
    type WriteExecutionMeta,
} from "../src/renderer/tool/diff/write-execution.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThemeRendererHost } from "../src/renderer/index.ts";
import { LUNE_THEME_RENDERER, type LuneThemeRenderer } from "../src/protocol.ts";
import { config, DEFAULT_CONFIG, setConfig } from "../src/config/config.ts";
import { WriteExecutionMetadataStore } from "../src/renderer/tool/diff/write-execution.ts";
import { shikiHighlightCache } from "../src/renderer/tool/diff/shiki-highlight.ts";

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
function fixture(t: TestContext, mode: "on" | "compact" = "on", nativeMouse = false) {
    const previous = { ...config, excludeRenderers: [...config.excludeRenderers] };
    // Color interpolation is only observable with truecolor; 256-color terminals quantize frames together.
    const previousColorTerm = process.env.COLORTERM;
    process.env.COLORTERM = "truecolor";
    t.after(() => {
        if (previousColorTerm === undefined) delete process.env.COLORTERM;
        else process.env.COLORTERM = previousColorTerm;
    });
    initTheme("dark");
    const theme = getThemeByName("dark")!;
    setThemeInstance(theme);
    setConfig({ ...DEFAULT_CONFIG, mode, editDiffCollapsedLines: 0 });
    const chat = new Container();
    const widgets = new Map<string, Component>();
    let resolver: Resolver;
    let requests = 0;
    let immediateFrames = 0;
    const listeners = new Map<string, Set<(event: never) => void>>();
    const api = {
        registerToolRenderer(value: Resolver) {
            resolver = value;
        },
        on(name: string, listener: (event: never) => void) {
            const values = listeners.get(name) ?? new Set();
            values.add(listener);
            listeners.set(name, values);
            return () => values.delete(listener);
        },
    } as unknown as ExtensionAPI;
    let terminalInput: ((data: string) => void) | undefined;
    let outputPanel: Component | undefined;
    let outputReady: ((panel: Component) => void) | undefined;
    const notices: string[] = [];
    const terminal: Terminal = {
        columns: 120,
        rows: 40,
        kittyProtocolActive: false,
        start(input) {
            terminalInput = input;
        },
        stop() {},
        drainInput: async () => {},
        write() {},
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
    };
    const checkOutput = () => {
        if (
            outputPanel &&
            outputReady &&
            lines(outputPanel).some((line) => line.includes("Full output ·"))
        ) {
            outputReady(outputPanel);
            outputReady = undefined;
        }
    };
    const nativeTui = nativeMouse ? new TuiAltScreen(terminal) : undefined;
    const tui = nativeTui ?? {
        mode: "fullscreen",
        terminal,
        children: [chat],
        requestRender() {
            requests++;
            checkOutput();
        },
        renderNow() {
            immediateFrames++;
        },
    };
    if (nativeTui) {
        nativeTui.addChild(chat);
        const requestRender = nativeTui.requestRender.bind(nativeTui);
        nativeTui.requestRender = (force) => {
            requests++;
            checkOutput();
            requestRender(force);
        };
        nativeTui.start();
        t.after(() => nativeTui.stop());
    }
    const context = {
        cwd: process.cwd(),
        mode: "tui",
        hasUI: true,
        ui: {
            theme,
            setWidget(
                key: string,
                factory?: (host: typeof tui, theme: typeof context.ui.theme) => Component,
            ) {
                if (factory) widgets.set(key, factory(tui, theme));
                else widgets.delete(key);
            },
            onTerminalInput(listener: (data: string) => void) {
                return (
                    nativeTui?.addInputListener((data) => {
                        listener(data);
                        return undefined;
                    }) ?? (() => {})
                );
            },
            notify(message: string) {
                notices.push(message);
            },
            custom(
                factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
                options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
            ) {
                return new Promise<void>((resolve) => {
                    let overlay: ReturnType<TuiAltScreen["showOverlay"]> | undefined;
                    outputPanel = factory(tui as never, theme, {} as never, () => {
                        overlay?.hide();
                        outputPanel = undefined;
                        resolve();
                    }) as Component;
                    if (nativeTui)
                        overlay = nativeTui.showOverlay(
                            outputPanel,
                            typeof options?.overlayOptions === "function"
                                ? options.overlayOptions()
                                : options?.overlayOptions,
                        );
                });
            },
        },
    } as unknown as ExtensionContext;
    const runningTools = new Set<ToolExecutionComponent>();
    const host = createThemeRendererHost(api, new WriteExecutionMetadataStore());
    const mounted = host.mount(context);
    t.after(() => {
        // Restoring a partial native bash renderer starts Pi's duration timer; retire fixture calls first.
        for (const card of runningTools)
            card.updateResult({ content: [], details: undefined, isError: false });
        mounted.dispose();
        shikiHighlightCache.clear();
        setConfig(previous);
    });
    const nativeTools = new Map(
        [
            createReadToolDefinition,
            createEditToolDefinition,
            createWriteToolDefinition,
            createBashToolDefinition,
            createFindToolDefinition,
            createGrepToolDefinition,
            createLsToolDefinition,
            createPowerShellToolDefinition,
        ].map((create) => {
            const tool = create(process.cwd());
            return [tool.name, tool] as const;
        }),
    );
    let sequence = 0;
    const create = (name: string, args: Record<string, unknown>) => {
        const native = nativeTools.get(name) as ToolRenderers | undefined;
        const renderers = resolver(name, () => native);
        return new ToolExecutionComponent(
            name,
            `tool-${sequence++}`,
            args,
            { showImages: false },
            renderers,
            tui as never,
            process.cwd(),
        );
    };
    const add = (
        name: string,
        args: Record<string, unknown> = { path: "file.ts" },
        result: Result = {
            content: [{ type: "text", text: "first line\nsecond line" }],
            details: undefined,
        },
        separator = true,
        running = false,
        started = true,
    ) => {
        const card = create(name, args);
        if (started) card.markExecutionStarted();
        card.setArgsComplete();
        card.updateResult({ ...result, isError: false }, running);
        if (running) runningTools.add(card);
        if (separator) chat.addChild(new Text("Separator", 0, 0));
        chat.addChild(card);
        return card;
    };
    // Pi mounts a card while the model is still writing its arguments: no result, not executing.
    const stream = (name: string, args: Record<string, unknown> = {}) => {
        const card = create(name, args);
        runningTools.add(card);
        chat.addChild(new Text("Separator", 0, 0));
        chat.addChild(card);
        return card;
    };
    const target = (card: Component) =>
        chat.children.find(
            (component) => component instanceof Container && component.children.includes(card),
        ) ?? card;
    const emit = (name: string, event: unknown) => {
        for (const listener of listeners.get(name) ?? []) listener(event as never);
    };
    return {
        add,
        stream,
        target,
        emit,
        chat,
        theme,
        tui,
        terminalInput: (data: string) => terminalInput?.(data),
        nextOutput: () =>
            new Promise<Component>((resolve) => {
                outputReady = resolve;
            }),
        outputPanel: () => outputPanel,
        notices,
        immediateFrames: () => immediateFrames,
        mounted,
        widgets,
        listeners,
        requests: () => requests,
        // Pi's rebuild recreates components under the same tool call ids.
        rebuildChat() {
            chat.clear();
            sequence = 0;
        },
    };
}
// A running call shows a moon phase instead of a status word.
const RUNNING_MARK = "[◐◓◑◒]";
// Expanded cards frame their section labels; matching the whole row avoids hits on prose.
const INPUT_LABEL = /^\s*│ input\s*$/m;
const SCRIPT_LABEL = /^\s*│ script\s*$/m;
function lines(component: Component, width = 120) {
    return component.render(width).map(stripVTControlCharacters);
}
function output(component: Component) {
    return lines(component).join("\n");
}
function click(component: Component, row: number, column: number, width = 120) {
    const height = component.render(width).length;
    return component.handleMouse?.({
        type: "click",
        button: "left",
        x: column,
        y: row,
        screenX: column,
        screenY: row,
        width,
        height,
    } as TuiMouseEvent);
}
function clickDisclosure(component: Component) {
    const rendered = lines(component);
    const row = rendered.findIndex((line) => /click to show more/.test(line));
    if (row < 0) {
        click(component, 1, 1);
        return;
    }
    const column = rendered[row]!.search(/click to show more/);
    click(component, row, column);
}

for (const mode of ["on", "compact"] as const) {
    test(`${mode} collapsed cards open only from hints and every expanded panel closes from content`, (t) => {
        const runtime = fixture(t, mode);
        for (const name of [
            "read",
            "bash",
            "powershell",
            "grep",
            "find",
            "ls",
            "edit",
            "write",
            "codemode",
            "multi_tool_use.parallel",
            "mcp__server__tool",
        ]) {
            const args =
                name === "codemode"
                    ? { code: "text(1);" }
                    : name === "write"
                      ? { path: "file.ts", content: "after\n" }
                      : { path: "file.ts", command: "echo done", pattern: "value" };
            const details =
                name === "edit"
                    ? { diff: "-1 before\n+1 after" }
                    : name === "write"
                      ? {
                            luneThemeWrite: {
                                previousContent: "before\n",
                                fileExistedBeforeWrite: true,
                            },
                        }
                      : undefined;
            const card = runtime.add(name, args, {
                content: [{ type: "text", text: "first line\nsecond line" }],
                details,
            });
            const target = runtime.target(card);
            const collapsed = output(target);
            assert.equal((collapsed.match(/click to show more/g) ?? []).length, 1, name);
            assert.doesNotMatch(collapsed, /▸ expand|\[preview\]/);
            click(target, 0, 0);
            click(card, 1, 1);
            click(target, target.render(120).length - 1, 119);
            assert.equal(output(target), collapsed, name);
            clickDisclosure(target);
            const expanded = output(target);
            assert.match(expanded, name === "codemode" ? SCRIPT_LABEL : INPUT_LABEL);
            assert.doesNotMatch(expanded, /Collapse|click to show more|\[preview\]|↳/);
            click(target, 3, 1);
            assert.equal(output(target), collapsed, name);
        }
    });
}

test("expanded card backgrounds survive clipped summaries, syntax resets and nested diff backgrounds", (t) => {
    const assertBackground = (row: string) => {
        let background = false;
        let inside = false;
        for (const token of row.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
            if (token[1] !== undefined) {
                const parameters = token[1] ? token[1].split(";").map(Number) : [0];
                for (let index = 0; index < parameters.length; index++) {
                    const code = parameters[index]!;
                    if (code === 0 || code === 49) background = false;
                    else if (
                        code === 48 ||
                        (code >= 40 && code <= 47) ||
                        (code >= 100 && code <= 107)
                    )
                        background = true;
                    if (code === 38 || code === 48) index += parameters[index + 1] === 2 ? 4 : 2;
                }
            } else {
                for (const character of token[2]!) {
                    if (character === "│") inside = true;
                    if (inside)
                        assert.ok(
                            background,
                            `Expanded content lost its background: ${JSON.stringify(row)}`,
                        );
                }
            }
        }
    };
    for (const mode of ["on", "compact"] as const) {
        const runtime = fixture(t, mode);
        const calls = [
            {
                name: "read",
                args: { path: "deep/".repeat(30) + "source.ts" },
                status: "ok",
                durationMs: 82,
            },
        ];
        for (const name of ["bash", "read", "codemode", "multi_tool_use.parallel"]) {
            const args =
                name === "codemode"
                    ? {
                          code: `text(await tools.read({ path: '${"deep/".repeat(30)}source.ts' }));`,
                      }
                    : name === "multi_tool_use.parallel"
                      ? { tool_uses: [{ recipient_name: "read", parameters: calls[0]!.args }] }
                      : {
                            path: calls[0]!.args.path,
                            command: `python3 -c '${"print(123); ".repeat(30)}'`,
                        };
            const card = runtime.add(name, args, {
                content: [{ type: "text", text: "output ".repeat(100) }],
                details:
                    name === "codemode" || name === "multi_tool_use.parallel"
                        ? { calls }
                        : undefined,
            });
            const target = runtime.target(card);
            clickDisclosure(target);
            const rendered = target.render(78);
            assert.ok(
                rendered.some((row) => row.includes("…")),
                "The scenario includes actual clipping",
            );
            for (const row of rendered.filter((line) =>
                stripVTControlCharacters(line).includes("│"),
            ))
                assertBackground(row);
        }
        for (const hovered of [false, true])
            assertBackground(
                framedRow(
                    runtime.theme,
                    `clipped…\x1b[0m tail ${runtime.theme.bg("toolErrorBg", "nested diff")} restored`,
                    78,
                    hovered,
                ),
            );
        runtime.mounted.dispose();
    }
});

test("tool and composite headers use phase-specific status marks before and after expansion", (t) => {
    const runtime = fixture(t);
    const result: Result = { content: [{ type: "text", text: "finished" }], details: undefined };
    type Phase = "running" | "done" | "failed" | "cancelled";
    const colors = {
        running: "accent",
        done: "success",
        failed: "error",
        cancelled: "dim",
    } as const;
    const assertHeading = (component: Component, name: string, status: Phase) => {
        // Running calls wax through the moon phases; settled calls are full or new moons.
        const marks =
            status === "running" ? ["◐", "◓", "◑", "◒"] : [status === "cancelled" ? "○" : "●"];
        const heading = component
            .render(120)
            .find((row) =>
                marks.some((mark) => stripVTControlCharacters(row).includes(`${mark} ${name}`)),
            );
        assert.ok(heading, `${name} has a ${status} mark`);
        assert.ok(
            marks.some((mark) => heading.includes(runtime.theme.fg(colors[status], mark))),
            `${name} uses ${colors[status]} for its ${status} mark`,
        );
    };
    const bash = runtime.add("bash", { command: "npm run typecheck" }, result);
    for (const phase of [
        { partial: false, error: false, status: "done" },
        { partial: true, error: false, status: "running" },
        { partial: false, error: true, status: "failed" },
    ] as const) {
        bash.updateResult({ ...result, isError: phase.error }, phase.partial);
        for (const expanded of [false, true]) {
            bash.setExpanded(expanded);
            assertHeading(bash, "bash", phase.status);
        }
    }
    for (const name of ["codemode", "multi_tool_use.parallel"]) {
        const card = runtime.add(
            name,
            name === "codemode"
                ? { code: "text(await tools.read({path:'file.ts'}));" }
                : { tool_uses: [{ recipient_name: "read", parameters: { path: "file.ts" } }] },
            result,
        );
        for (const phase of [
            { statuses: ["ok", "ok"], partial: false, error: false, status: "done" },
            { statuses: ["ok", "running"], partial: true, error: false, status: "running" },
            { statuses: ["error", "running"], partial: true, error: false, status: "failed" },
            { statuses: ["ok", "ok"], partial: false, error: true, status: "failed" },
            {
                statuses: ["cancelled", "cancelled"],
                partial: false,
                error: false,
                status: "cancelled",
            },
        ] as const) {
            card.updateResult(
                {
                    ...result,
                    isError: phase.error,
                    details: {
                        calls: phase.statuses.map((status, index) => ({
                            name: "read",
                            args: { path: `file-${index}.ts` },
                            status,
                        })),
                    },
                },
                phase.partial,
            );
            for (const expanded of [false, true]) {
                card.setExpanded(expanded);
                assertHeading(card, name, phase.status);
            }
        }
    }
    const read = runtime.add("read");
    const groupedBash = runtime.add("bash", { command: "echo done" }, result, false);
    const group = runtime.target(read);
    assertHeading(group, "tools", "done");
    groupedBash.updateResult({ ...result, isError: false }, true);
    assertHeading(group, "tools", "running");
    groupedBash.updateResult({ ...result, isError: true });
    assertHeading(group, "tools", "failed");
    clickDisclosure(group);
    assertHeading(group, "tools", "failed");
    assertHeading(group, "read", "done");
    assertHeading(group, "bash", "failed");
});

test("groups expand through one hint, opening another card collapses the previous group and the next assistant message leaves the new card open", (t) => {
    const runtime = fixture(t);
    const first = runtime.add("read");
    runtime.add("bash", { command: "echo done" }, undefined, false);
    const group = runtime.target(first);
    assert.match(output(group), /● tools {2}2 calls · click to show more/);
    assert.equal((output(group).match(/click to show more/g) ?? []).length, 1);
    clickDisclosure(group);
    assert.doesNotMatch(output(group), /Collapse/);
    assert.match(output(group), INPUT_LABEL);
    const other = runtime.add("ls");
    clickDisclosure(runtime.target(other));
    assert.match(output(group), /click to show more/);
    assert.doesNotMatch(output(group), INPUT_LABEL);
    runtime.emit("message_start", { message: { role: "assistant" } });
    assert.match(output(other), INPUT_LABEL);
});

test("unchanged completed tools and groups reuse rendering while results, width and configuration stay live", (t) => {
    const runtime = fixture(t);
    const card = runtime.add("read");
    let styles = 0;
    const fg = runtime.theme.fg.bind(runtime.theme);
    runtime.theme.fg = (...args) => {
        styles++;
        return fg(...args);
    };
    t.after(() => {
        runtime.theme.fg = fg;
    });
    const expected = output(card);
    const before = styles;
    for (let frame = 0; frame < 100; frame++) assert.equal(output(card), expected);
    assert.equal(
        styles,
        before,
        "Unchanged historical frames do not recolor and relayout the card",
    );
    card.updateResult({
        content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }],
        details: undefined,
        isError: false,
    });
    assert.match(output(card), /6 lines/);
    assert.ok(styles > before);
    for (const width of [1, 2, 8, 18, 40, 120])
        for (const row of card.render(width)) assert.ok(visibleWidth(row) <= width);
    const second = runtime.add(
        "write",
        { path: "file.ts", content: "after\n" },
        {
            content: [{ type: "text", text: "written" }],
            details: {
                luneThemeWrite: { previousContent: "before\n", fileExistedBeforeWrite: true },
            },
        },
        false,
    );
    const group = runtime.target(card);
    const groupExpected = output(group);
    const groupBefore = styles;
    for (let frame = 0; frame < 100; frame++) assert.equal(output(group), groupExpected);
    assert.equal(styles, groupBefore, "Completed groups do not reparse diff counts on every frame");
    second.updateResult({
        content: [{ type: "text", text: "failed" }],
        details: undefined,
        isError: true,
    });
    assert.match(output(group), /1 failed/);
    setConfig({ ...config, previewLines: 0 });
    assert.doesNotMatch(output(group), /file\.ts/);
    clickDisclosure(group);
    assert.doesNotMatch(output(group), /Collapse/);
});

test("expanded overwrite diffs show changed lines without laying out long unchanged files", (t) => {
    const runtime = fixture(t);
    const before = Array.from(
        { length: 800 },
        (_, index) => `export const value${index} = 1;`,
    ).join("\n");
    const after = before.replace("value400 = 1", "value400 = 2");
    const card = runtime.add(
        "write",
        { path: "file.ts", content: after },
        {
            content: [{ type: "text", text: "File written" }],
            details: { luneThemeWrite: { previousContent: before, fileExistedBeforeWrite: true } },
        },
    );
    assert.match(output(card), /\+1.*-1/);
    clickDisclosure(card);
    const actual = output(card);
    assert.match(actual, /value400 = 1/);
    assert.match(actual, /value400 = 2/);
    assert.doesNotMatch(actual, /value200 = 1/);
    assert.ok(card.render(120).length < 80);
    assert.doesNotMatch(actual, /Collapse/);
});

test("reused streaming result and diff objects refresh rather than retaining cached content", (t) => {
    const runtime = fixture(t);
    const result = {
        content: [{ type: "text" as const, text: "one" }],
        details: undefined,
        isError: false,
    };
    const card = runtime.add("read", { path: "file.ts" }, result);
    assert.match(output(card), /● read {2}file\.ts · 1 line · /);
    result.content[0]!.text = "one\ntwo\nthree\nfour\nfive\nsix";
    card.updateResult(result, true);
    assert.match(output(card), /six/, "Streaming shows the newest lines of the reused result");
    assert.doesNotMatch(output(card), /1 line\b/);
    card.updateResult(result);
    assert.match(output(card), /● read {2}file\.ts · 6 lines · /);
    result.content[0]!.text = "finished";
    card.updateResult(result);
    clickDisclosure(card);
    assert.match(output(card), /finished/);
    assert.doesNotMatch(output(card), /three/);

    const edited = {
        content: [{ type: "text" as const, text: "edited" }],
        details: { diff: "-1 before\n+1 after" },
        isError: false,
    };
    const edit = runtime.add("edit", { path: "file.ts" }, edited);
    assert.match(output(edit), /● edit {2}file\.ts · \+1 -1 · .*click to show more/);
    assert.equal(
        lines(edit).filter((row) => row.trim()).length,
        1,
        "A collapsed edit card has no diff body row when no collapsed lines are configured",
    );
    edited.details.diff += "\n+2 another";
    edit.updateResult(edited);
    assert.match(output(edit), /\+2.*-1/);
});

test("call trees show five rows, overflow opens every call, and panel clicks close it", (t) => {
    const runtime = fixture(t);
    const first = runtime.add("read", { path: "file-0.ts" });
    for (let index = 1; index < 5; index++)
        runtime.add("read", { path: `file-${index}.ts` }, undefined, false);
    const group = runtime.target(first);
    assert.equal(lines(group).filter((row) => /[├└] ● read/.test(row)).length, 5);
    assert.doesNotMatch(output(group), /more call|↳/);
    runtime.add("bash", { command: "echo six" }, undefined, false);
    const collapsed = output(group);
    assert.match(collapsed, /… 1 more call\b/);
    assert.doesNotMatch(collapsed, /echo six/);
    const rendered = lines(group);
    const row = rendered.findIndex((line) => line.includes("… 1 more call"));
    click(group, row, rendered[row]!.indexOf("1 more call"));
    assert.match(output(group), /echo six/);
    assert.doesNotMatch(output(group), /Collapse|click to show more|more call/);
    click(group, 3, 100);
    assert.equal(output(group), collapsed);
});

test("codemode replays a compact call ledger without nested write or edit diffs", (t) => {
    const runtime = fixture(t, "compact");
    const calls = Array.from({ length: 6 }, (_, index) => ({
        id: `nested-${index}`,
        name: index === 0 ? "write" : "edit",
        args: { path: `file-${index}.ts`, content: "new_content\n" },
        status: index === 5 ? "failed" : "done",
        durationMs: 60,
        result: {
            content: [],
            details: {
                diff: "-1 old_content\n+1 new_content",
                luneThemeWrite: { previousContent: "old_content\n", fileExistedBeforeWrite: true },
            },
        },
    }));
    const card = runtime.add(
        "codemode",
        { code: "text('script');" },
        {
            content: [{ type: "text", text: "script completed" }],
            details: { calls, luneThemeNestedDiffs: calls },
        },
    );
    assert.equal(runtime.target(card), card, "Compact mode keeps codemode as a single card");
    const collapsed = output(card);
    assert.match(collapsed, /● codemode {2}6 calls · 1 failed · click to show more/);
    assert.doesNotMatch(collapsed, /0 running|0 failed|\(|:/);
    assert.match(collapsed, /├ ● write {2}file-0\.ts · \+1 -1 · 60ms/);
    assert.doesNotMatch(collapsed, /file-5.ts|old_content|new_content|diff|↳/);
    assert.match(collapsed, /… 1 more call\b/);
    clickDisclosure(card);
    const expanded = output(card);
    assert.match(expanded, SCRIPT_LABEL);
    assert.match(expanded, /└ ● edit {2}file-5\.ts · failed · 60ms/);
    assert.doesNotMatch(expanded, /old_content|new_content|^\s*│ diff\s*$|diff \+|Collapse/m);
    click(card, 4, 100);
    assert.equal(output(card), collapsed);
});

test("shell summaries describe command chains and keep outcome metadata next to the command", (t) => {
    const runtime = fixture(t);
    const command =
        "bash .scripts/format-ts.sh && npm run typecheck && node --experimental-strip-types --test test/core/theme-renderer.test.ts && node /tmp/verify.mjs";
    const expected = "bash .scripts/format-ts.sh · npm run typecheck · +2 commands";
    assert.equal(commandSummary(command), expected);
    assert.equal(
        commandSummary("bash -lc 'npm run build && npm test'"),
        "npm run build · npm test",
    );
    assert.equal(commandSummary("printf '%s' 'a && b' | wc -l"), "printf %s a && b | wc -l");
    const card = runtime.add("bash", { command });
    const head = lines(card)[1]!;
    assert.match(
        head,
        /● bash {2}bash .scripts\/format-ts.sh · npm run typecheck · \+2 commands · 2 lines/,
    );
    assert.doesNotMatch(head, /\{"command"|experimental-strip-types|\bdone\b/);
    clickDisclosure(card);
    assert.match(
        output(card),
        /experimental-strip-types/,
        "Expanded input retains the actual command",
    );
});

test("command summaries fit whole commands greedily and never clip the hidden-command suffix", () => {
    assert.equal(commandSummary("a && b && c"), "a · b · +1 command");
    assert.equal(commandSummary("a; b; c; d"), "a · b · +2 commands");
    assert.equal(commandSummary("a && b"), "a · b");
    const wide = `tool ${"a".repeat(36)} ${"b".repeat(36)}`;
    // The second command would overflow 80 columns, so only the clipped first one is shown.
    const dropped = commandSummary(`${wide} && next`);
    assert.equal(dropped, `tool ${"a".repeat(36)} ${"b".repeat(24)}… · +1 command`);
    const clipped = commandSummary(`${wide} ${"c".repeat(36)} && next && x`);
    assert.ok(visibleWidth(clipped) <= 80, `width ${visibleWidth(clipped)} exceeds 80`);
    assert.ok(clipped.endsWith("… · +2 commands"), clipped);
    assert.equal(commandSummary("tool a b c d"), "tool a b c +1 arg");
    assert.equal(commandSummary("tool a b c d e"), "tool a b c +2 args");
});

test("command summaries and fitSummary emit plain text without ANSI sequences", () => {
    const long = `grep ${"p".repeat(60)} && next ${"q".repeat(60)} && x`;
    assert.ok(!commandSummary(long).includes("\x1b"));
    assert.ok(!commandSummary(`curl https://example.com/${"x".repeat(60)}`).includes("\x1b"));
    // Trailing whitespace before the ellipsis is trimmed.
    assert.equal(fitSummary("abcd efghij", 6, 0), "abcd…");
    assert.equal(fitSummary("abcdefghij", 20, 5), "abcd…");
    assert.equal(fitSummary("short", 20, 0), "short");
    assert.ok(!fitSummary(`tool ${"z".repeat(80)}`, 30, 0).includes("\x1b"));
});

test("command summaries keep path tails but URL and plain argument heads", () => {
    const path = "/Users/someone/projects/app/node_modules/@scope/pkg-name";
    const pathSummary = commandSummary(`ls ${path}`);
    assert.match(pathSummary, /^ls …\/.*\/@scope\/pkg-name$/);
    assert.ok(visibleWidth(pathSummary.slice(3)) <= 36);
    const url = `https://example.com/${"x".repeat(50)}`;
    const urlSummary = commandSummary(`curl ${url}`);
    assert.ok(urlSummary.startsWith("curl https://example.com/x"), urlSummary);
    assert.ok(urlSummary.endsWith("…") && !urlSummary.includes("…/"), urlSummary);
    assert.equal(commandSummary(`grep ${"p".repeat(50)}`), `grep ${"p".repeat(35)}…`);
    assert.equal(commandSummary("ls short/path"), "ls short/path");
});

test("command summaries treat redirection ampersands as arguments, not separators", () => {
    assert.equal(commandSummary("make 2>&1"), "make 2>&1");
    assert.equal(commandSummary("make 2>&1 | tee build.log"), "make 2>&1 | tee build.log");
    assert.equal(commandSummary("cmd &> out.txt && next"), "cmd &> out.txt · next");
    assert.equal(commandSummary("a & b"), "a · b", "A real background ampersand still separates");
});

test("command summaries count a pipeline as one command and use dots between commands", () => {
    assert.equal(commandSummary("ls x | wc -l"), "ls x | wc -l");
    assert.equal(commandSummary("a | b | c"), "a | b | c");
    assert.equal(commandSummary("a | b | c && d && e"), "a | b | c · d · +1 command");
    assert.equal(commandSummary("a ; b"), "a · b");
    assert.equal(commandSummary("a || b"), "a · b");
    assert.equal(commandSummary("a\nb"), "a · b");
});

test("command summaries skip cd and bare echo noise unless nothing else remains", () => {
    assert.equal(commandSummary("cd /x && make"), "make");
    assert.equal(commandSummary("cd /x && echo a && make && ls"), "make · ls");
    assert.equal(commandSummary("echo start && npm test"), "npm test");
    assert.equal(commandSummary("echo hi"), "echo hi");
    assert.equal(commandSummary("cd /x && echo hi"), "cd /x · echo hi");
    assert.equal(commandSummary("echo hi | wc -c"), "echo hi | wc -c");
    assert.equal(commandSummary("echo x > out.txt && ls"), "echo x > out.txt · ls");
});

test("command summaries drop units whose summary is empty", () => {
    assert.equal(commandSummary("bash -c '' && ls"), "ls");
    assert.equal(commandSummary("bash -c ''"), "");
});

test("command summaries skip heredoc bodies but not here-strings", () => {
    assert.equal(
        commandSummary("git commit -F - <<'EOF'\nfeat: x\n\nbody && more; a | b\nEOF\ngit push"),
        "git commit -F - · git push",
    );
    assert.equal(commandSummary("cat <<-EOF\n\tbody && x\n\tEOF\nls"), "cat · ls");
    assert.equal(commandSummary("cat <<EOF | wc -l\nhello && x\nEOF"), "cat | wc -l");
    assert.equal(commandSummary("cat <<EOF\nbody && never-terminated"), "cat");
    assert.equal(commandSummary("cat <<< hello && ls"), "cat <<< hello · ls");
});

test("command summaries stay readable for long real-world command chains", () => {
    const logs =
        "cd /Users/sy/.pi/agent/local-extensions && " +
        'echo "=== pi-compaction init ===" && git -C pi-compaction log -1 --format=%B c61eadc && ' +
        'echo "=== pi-recap init ===" && git -C pi-recap log -1 --format=%B 5bc7936 && ' +
        "echo \"=== pi-lune-core theme commits ===\" && git -C pi-lune-core log --format='%h%n%B---' -3 1c307df && " +
        'echo "=== pi-brave init ===" && git -C pi-brave-support log -1 --format=%B b0cbc25';
    assert.equal(
        commandSummary(logs),
        "git -C pi-compaction log +3 args · git -C pi-recap log +3 args · +2 commands",
    );
    const staged =
        "cd /x/pi-core-theme && git add -A && git status --short | head -5 && " +
        'echo "=== staged count ===" && git diff --cached --name-only | wc -l && ' +
        'echo "=== secrets scan ===" && git diff --cached --name-only | grep -Ei \'\\.env|token\' || echo "none"';
    assert.equal(commandSummary(staged), "git add -A · git status --short | head -5 · +2 commands");
});

test("command summaries keep scanning commands after a very long heredoc body", () => {
    const body = "console.log('line of script; a && b | c');\n".repeat(1200);
    const command = `cat > /tmp/x.mjs <<'EOF'\n${body}EOF\nnode /tmp/x.mjs && echo done`;
    assert.ok(command.length > 50_000);
    assert.equal(commandSummary(command), "cat > /tmp/x.mjs · node /tmp/x.mjs");
});

test("command summaries bound very long chains by the scan limit", () => {
    const command = Array.from(
        { length: 600 },
        (_, index) => `git -C repo${index} log -1 --format=%B abc${index}`,
    ).join(" && ");
    const actual = commandSummary(command);
    const prefix = "git -C repo0 log +3 args · git -C repo1 log +3 args · +";
    assert.ok(actual.startsWith(prefix), actual);
    assert.ok(actual.endsWith(" commands"), actual);
});

test("command summaries are stable across repeated calls and cache eviction", () => {
    const first = commandSummary("bash -lc 'npm run build && npm test'");
    assert.equal(first, "npm run build · npm test");
    assert.equal(commandSummary("bash -lc 'npm run build && npm test'"), first);
    const commands = Array.from(
        { length: 200 },
        (_, index) => `tool-${index} arg && next-${index}`,
    );
    const expected = commands.map((_, index) => `tool-${index} arg · next-${index}`);
    const firstPass = commands.map((command) => commandSummary(command));
    assert.deepEqual(firstPass, expected);
    // Earlier entries were evicted by now; recomputed output must be unchanged.
    assert.deepEqual(
        commands.map((command) => commandSummary(command)),
        expected,
    );
    assert.equal(commandSummary("bash -lc 'npm run build && npm test'"), first);
});

test("thinking follows streamed tokens and animation frames request throttled renders without re-laying out text", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1000 });
    const runtime = fixture(t);
    const message = {
        role: "assistant",
        content: [
            {
                type: "thinking",
                thinking: Array.from({ length: 12 }, (_, index) => `thought-${index}`).join("\n"),
            },
        ],
        timestamp: 1000,
    } as AssistantMessage;
    const assistant = new AssistantMessageComponent(message, false, getMarkdownTheme());
    runtime.chat.addChild(assistant);
    runtime.emit("message_update", {
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assistant.updateContent(message, true);
    assert.match(output(assistant), /thought-11/);
    assert.doesNotMatch(output(assistant), /thought-0\b/);
    message.content[0] = { type: "thinking", thinking: "latest-live-token" };
    assistant.updateContent(message, true);
    assert.match(output(assistant), /latest-live-token/);
    assert.doesNotMatch(output(assistant), /thought-11/);
    clickDisclosure(assistant);
    message.content[0] = { type: "thinking", thinking: "latest-live-token\nexpanded-live-token" };
    assistant.updateContent(message, true);
    assert.match(output(assistant), /expanded-live-token/);
    output(assistant);
    const nativeRender = Markdown.prototype.render;
    const nativeTextRender = Text.prototype.render;
    let layouts = 0;
    t.mock.method(Text.prototype, "render", function (this: Text, width: number) {
        layouts++;
        return nativeTextRender.call(this, width);
    });
    t.mock.method(Markdown.prototype, "render", function (this: Markdown, width: number) {
        layouts++;
        return nativeRender.call(this, width);
    });
    const requestsBefore = runtime.requests();
    const ticks = 120;
    for (let index = 0; index < ticks; index++) {
        t.mock.timers.tick(THINKING_FRAME_MS);
        output(assistant);
    }
    assert.equal(layouts, 0, "Animation frames reuse unchanged text and Markdown layouts");
    assert.equal(runtime.immediateFrames(), 0, "Animation never forces an immediate render");
    const requested = runtime.requests() - requestsBefore;
    assert.ok(
        requested >= ticks - 2 && requested <= ticks + 2,
        `Animation requests about one render per tick, got ${requested}`,
    );
    const animation = new ThinkingAnimation();
    const first = animation.render(runtime.theme, 1000);
    const second = animation.render(runtime.theme, 1000 + THINKING_FRAME_MS);
    assert.notEqual(first, second, "Color interpolation advances between glyph changes");
    assert.match(stripVTControlCharacters(first), /^[·✢✳✶✻✽] Thinking$/);
    runtime.emit("message_end", { message });
    const requestsAtEnd = runtime.requests();
    t.mock.timers.tick(1000);
    assert.equal(
        runtime.requests(),
        requestsAtEnd,
        "Thinking completion stops the animation timer",
    );
    assert.equal(runtime.immediateFrames(), 0);
});

test("native write captures new-file and overwrite diffs, including large replacement blocks", async (t) => {
    const runtime = fixture(t);
    const directory = await mkdtemp(join(tmpdir(), "lune-write-diff-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    type WriteDefinition = ToolDefinition<
        ReturnType<typeof createWriteToolDefinition>["parameters"],
        { luneThemeWrite?: WriteExecutionMeta } | undefined
    >;
    let writer: WriteDefinition | undefined;
    const adapter = createWriteMetadataAdapter(
        {
            getAllTools: () => [{ name: "write", sourceInfo: { source: "builtin" } }],
            getActiveTools: () => ["write"],
            registerTool: (tool: WriteDefinition) => {
                writer = tool;
            },
        } as unknown as ExtensionAPI,
        new WriteExecutionMetadataStore(),
        () => true,
    );
    const context = { cwd: directory } as ExtensionToolContext;
    adapter.ensure(context);
    const created = await writer!.execute(
        "created",
        { path: "probe.ts", content: "export const created = true;\n" },
        undefined,
        undefined,
        context,
    );
    const newFile = runtime.add(
        "write",
        { path: "probe.ts", content: "export const created = true;\n" },
        created,
    );
    assert.match(output(newFile), /● write {2}probe\.ts · new file · \+1 -0/);
    const before = Array.from({ length: 1500 }, (_, index) => `const old_${index} = 1;`).join("\n");
    const after = Array.from({ length: 1500 }, (_, index) => `const new_${index} = 2;`).join("\n");
    await writeFile(join(directory, "probe.ts"), before);
    const result = await writer!.execute(
        "overwritten",
        { path: "probe.ts", content: after },
        undefined,
        undefined,
        context,
    );
    assert.equal(result.details?.luneThemeWrite?.previousContent, before);
    assert.equal(await readFile(join(directory, "probe.ts"), "utf8"), after);
    const card = runtime.add("write", { path: "probe.ts", content: after }, result);
    assert.match(output(card), /● write {2}probe\.ts · \+1500 -1500/);
    setConfig({ ...config, diffViewMode: "split" });
    clickDisclosure(card);
    const actual = output(card);
    assert.match(actual, /old_0/);
    assert.match(actual, /new_0/);
    assert.doesNotMatch(actual, /diff omitted|↳/);
    assert.ok(card.render(120).length < 80);
});

test("empty thinking has no disclosure and streamed text updates without rebuilding assistant content", (t) => {
    const runtime = fixture(t);
    const message = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
        timestamp: 1234,
    } as AssistantMessage;
    const assistant = new AssistantMessageComponent(
        message,
        true,
        getMarkdownTheme(),
        undefined,
        undefined,
        [() => ""],
    );
    runtime.chat.addChild(assistant);
    runtime.emit("message_update", {
        message,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    assert.match(output(assistant), /Thinking/);
    assert.doesNotMatch(output(assistant), /click to show more|Collapse/);
    const initialThinking = (
        assistant as unknown as { contentContainer: Container }
    ).contentContainer.children.find((component) => /Thinking/.test(output(component)));
    const thinking = { type: "thinking" as const, thinking: "```mermaid\ngraph TD; newest_token" };
    message.content[0] = thinking;
    runtime.emit("message_update", {
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assert.match(output(assistant), /newest_token/);
    assert.match(output(assistant), /click to show more/);
    const heading = lines(assistant).findIndex((line) => /Thinking/.test(line));
    assert.match(
        lines(assistant)[heading]!,
        / Thinking( · [\d.]+s)? · click to show more$/,
        "The hint trails the heading row",
    );
    assert.match(lines(assistant)[heading + 1]!, /^ {3}\S/, "Preview rows are indented 3 columns");
    assert.equal(
        (assistant as unknown as { contentContainer: Container }).contentContainer.children.find(
            (component) => /Thinking/.test(output(component)),
        ),
        initialThinking,
    );
    clickDisclosure(assistant);
    thinking.thinking += "\nexpanded_stream_token";
    runtime.emit("message_update", {
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assert.match(output(assistant), /expanded_stream_token/);
    assert.doesNotMatch(output(assistant), /Collapse|click to show more/);
    click(assistant, 2, 90);
    assert.match(output(assistant), /click to show more/);
    const stateBefore = structuredClone(message);
    runtime.emit("message_end", { message });
    assert.match(output(assistant), /^ ✻ Thinking/m, "Completed thinking keeps a plain ✻ mark");
    assert.doesNotMatch(output(assistant), /✓/);
    assert.deepEqual(message, stateBefore, "Rendering never changes the model's thinking content");
});

for (const mode of ["on", "compact"] as const) {
    test(`${mode} planned parallel calls follow actual execution and match same-name calls by arguments`, (t) => {
        const runtime = fixture(t, mode);
        const tool_uses = Array.from({ length: 8 }, (_, index) => ({
            recipient_name: "read",
            parameters: { path: `planned-${index}.ts` },
        }));
        const card = runtime.add(
            "multi_tool_use.parallel",
            { tool_uses },
            { content: [], details: undefined },
            true,
            true,
        );
        assert.match(output(card), /planned-0\.ts/);
        assert.doesNotMatch(output(card), /planned-7\.ts/);
        runtime.emit("tool_execution_start", {
            toolCallId: "tool-0",
            toolName: "multi_tool_use.parallel",
            args: { tool_uses },
        });
        runtime.emit("tool_execution_start", {
            toolCallId: "child-7",
            parentToolCallId: "tool-0",
            toolName: "read",
            args: { path: "planned-7.ts" },
        });
        assert.equal(
            (output(card).match(/planned-7\.ts/g) ?? []).length,
            1,
            "A live call is not also attached to an unrelated same-name planned call",
        );
        runtime.emit("tool_execution_end", {
            toolCallId: "child-7",
            parentToolCallId: "tool-0",
            isError: false,
        });
        runtime.emit("tool_execution_start", {
            toolCallId: "child-0",
            parentToolCallId: "tool-0",
            toolName: "read",
            args: { path: "planned-0.ts" },
        });
        assert.match(output(card), new RegExp(`${RUNNING_MARK} read {2}planned-0\\.ts`));
        assert.doesNotMatch(output(card), /planned-7\.ts/);
        clickDisclosure(card);
        const actual = lines(card)
            .filter((line) => /[├└]/.test(line) && /read /.test(line))
            .join("\n");
        assert.match(actual, /● read {2}planned-7\.ts/);
        assert.match(actual, new RegExp(`${RUNNING_MARK} read {2}planned-0\\.ts`));
        for (let index = 0; index < 8; index++)
            assert.equal((actual.match(new RegExp(`planned-${index}\\.ts`, "g")) ?? []).length, 1);
    });

    test(`${mode} precreated tool groups follow execution starts rather than their unstarted tail`, (t) => {
        const runtime = fixture(t, mode);
        const cards = Array.from({ length: 8 }, (_, index) =>
            runtime.add(
                "read",
                { path: `queued-${index}.ts` },
                { content: [], details: undefined },
                index === 0,
                true,
                false,
            ),
        );
        const group = runtime.target(cards[0]!);
        assert.match(output(group), /queued-0\.ts/);
        assert.doesNotMatch(output(group), /queued-7\.ts/);
        for (let index = 0; index < 8; index++) {
            const card = cards[index]!;
            card.markExecutionStarted();
            runtime.emit("tool_execution_start", {
                toolCallId: `tool-${index}`,
                toolName: "read",
                args: { path: `queued-${index}.ts` },
            });
            assert.match(output(group), new RegExp(`${RUNNING_MARK} read {2}queued-${index}\\.ts`));
            if (index < 7) assert.doesNotMatch(output(group), /queued-7\.ts/);
            card.updateResult({ content: [], details: undefined, isError: false });
            runtime.emit("tool_execution_end", { toolCallId: `tool-${index}`, isError: false });
        }
        clickDisclosure(group);
        for (let index = 0; index < 8; index++)
            assert.match(output(group), new RegExp(`● read {2}queued-${index}\\.ts`));
    });

    test(`${mode} running codemode follows each new call beyond five and retains the complete expanded ledger`, (t) => {
        const runtime = fixture(t, mode);
        const card = runtime.add(
            "codemode",
            { code: "text(await tools.read({ path: 'step.ts' }));" },
            { content: [], details: { calls: [] } },
            true,
            true,
        );
        runtime.emit("tool_execution_start", {
            toolCallId: "tool-0",
            toolName: "codemode",
            args: {},
        });
        for (let index = 0; index < 8; index++) {
            const id = `nested-${index}`;
            runtime.emit("tool_execution_start", {
                toolCallId: id,
                parentToolCallId: "tool-0",
                toolName: "read",
                args: { path: `step-${index}.ts` },
            });
            const actual = output(card);
            assert.match(actual, new RegExp(`${RUNNING_MARK} read {2}step-${index}\\.ts`));
            if (index >= 5) assert.doesNotMatch(actual, /step-0\.ts/);
            runtime.emit("tool_execution_end", {
                toolCallId: id,
                parentToolCallId: "tool-0",
                isError: false,
                durationMs: 10,
            });
        }
        // The parent script is still running even though all eight nested calls settled.
        assert.match(
            output(card),
            new RegExp(`${RUNNING_MARK} codemode {2}8 calls · click to show more`),
        );
        assert.match(output(card), /… 3 more calls/);
        clickDisclosure(card);
        const expanded = output(card);
        for (let index = 0; index < 8; index++)
            assert.equal((expanded.match(new RegExp(`step-${index}\\.ts`, "g")) ?? []).length, 1);
        click(card, 2, 95);
        card.updateResult({ content: [], details: { calls: [] }, isError: false });
        runtime.emit("tool_execution_end", { toolCallId: "tool-0", isError: false });
        assert.match(output(card), /● read {2}step-0\.ts/);
        assert.doesNotMatch(output(card), /step-7\.ts/);
    });

    test(`${mode} grouped tools show the newest call and keep output live after expansion`, (t) => {
        const runtime = fixture(t, mode);
        setConfig({ ...config, expandedOutputMaxLines: 3 });
        const cards: ToolExecutionComponent[] = [];
        for (let index = 0; index < 7; index++) {
            const card = runtime.add(
                "bash",
                { command: `echo step-${index}` },
                { content: [], details: undefined },
                index === 0,
                true,
            );
            cards.push(card);
            runtime.emit("tool_execution_start", {
                toolCallId: `tool-${index}`,
                toolName: "bash",
                args: {},
            });
            if (index < 6) {
                card.updateResult({
                    content: [{ type: "text", text: `completed-${index}` }],
                    details: undefined,
                    isError: false,
                });
                runtime.emit("tool_execution_end", { toolCallId: `tool-${index}`, isError: false });
            }
        }
        const last = cards.at(-1)!;
        const group = runtime.target(last);
        assert.match(output(group), /7 calls · 1 running · click to show more/);
        assert.match(output(group), new RegExp(`${RUNNING_MARK} bash {2}echo step-6`));
        assert.doesNotMatch(output(group), /step-0/);
        const partial = {
            content: [
                {
                    type: "text" as const,
                    text:
                        Array.from({ length: 40 }, (_, index) => `earlier-group-${index}`).join(
                            "\n",
                        ) + "\nlatest-group-token",
                },
            ],
            details: undefined,
        };
        runtime.emit("tool_execution_update", {
            toolCallId: "tool-6",
            toolName: "bash",
            partialResult: partial,
        });
        last.updateResult({ ...partial, isError: false }, true);
        assert.match(output(group), /latest-group-token/);
        assert.doesNotMatch(output(group), /earlier-group-0\b/);
        clickDisclosure(group);
        assert.match(output(group), /step-0/);
        assert.match(output(group), /latest-group-token/);
        const next = {
            ...partial,
            content: [
                {
                    type: "text" as const,
                    text: partial.content[0]!.text + "\nexpanded-group-token",
                },
            ],
        };
        runtime.emit("tool_execution_update", {
            toolCallId: "tool-6",
            toolName: "bash",
            partialResult: next,
        });
        last.updateResult({ ...next, isError: false }, true);
        assert.match(output(group), /expanded-group-token/);
        assert.doesNotMatch(output(group), /earlier-group-0\b/);
        last.updateResult({
            content: [{ type: "text", text: "completed-output" }],
            details: undefined,
            isError: false,
        });
        runtime.emit("tool_execution_end", { toolCallId: "tool-6", isError: false });
        assert.match(output(group), /● bash {2}7 calls$/m);
        const expected = group.render(120);
        assert.equal(group.render(120), expected, "Completed groups reuse their rendered rows");
    });

    test(`${mode} standalone partial output follows its newest lines collapsed and expanded`, (t) => {
        const runtime = fixture(t, mode);
        setConfig({ ...config, expandedOutputMaxLines: 3 });
        const partial = {
            content: [
                {
                    type: "text" as const,
                    text:
                        Array.from({ length: 40 }, (_, index) => `earlier-output-${index}`).join(
                            "\n",
                        ) + "\nlatest-output-token",
                },
            ],
            details: undefined,
        };
        const card = runtime.add("bash", { command: "npm run build" }, partial, true, true);
        const target = runtime.target(card);
        assert.match(output(target), /latest-output-token/);
        assert.doesNotMatch(output(target), /earlier-output-0\b/);
        clickDisclosure(target);
        assert.match(output(target), /latest-output-token/);
        assert.doesNotMatch(output(target), /earlier-output-0\b/);
        const next = {
            ...partial,
            content: [
                {
                    type: "text" as const,
                    text: partial.content[0]!.text + "\nexpanded-output-token",
                },
            ],
        };
        card.updateResult({ ...next, isError: false }, true);
        assert.match(output(target), /expanded-output-token/);
        card.updateResult({ ...next, isError: false });
        assert.match(output(target), /earlier-output-0\b/);
    });
}

for (const name of ["codemode", "multi_tool_use.parallel"]) {
    test(`${name} nested partial events repaint output and expose all hidden lines`, async (t) => {
        const runtime = fixture(t, "compact");
        const card = runtime.add(name, {}, { content: [], details: { calls: [] } }, true, true);
        assert.equal(
            runtime.target(card),
            card,
            "Composite calls keep their own ledger before arguments arrive",
        );
        runtime.emit("tool_execution_start", { toolCallId: "tool-0", toolName: name, args: {} });
        runtime.emit("tool_execution_start", {
            toolCallId: "child",
            parentToolCallId: "tool-0",
            toolName: "bash",
            args: { command: "npm run build" },
        });
        clickDisclosure(card);
        const partial = {
            content: [
                {
                    type: "text" as const,
                    text:
                        Array.from({ length: 40 }, (_, index) => `nested-line-${index}`).join(
                            "\n",
                        ) + "\nnewest-nested-token",
                },
            ],
            details: undefined,
        };
        const requests = runtime.requests();
        runtime.emit("tool_execution_update", {
            toolCallId: "child",
            parentToolCallId: "tool-0",
            toolName: "bash",
            partialResult: partial,
        });
        assert.ok(
            runtime.requests() > requests,
            "Nested partial output requests an immediate repaint",
        );
        assert.match(output(card), /newest-nested-token/);
        assert.doesNotMatch(output(card), /nested-line-0\b/);
        const hidden = lines(card).findIndex((line) =>
            line.includes("more output · click to view full output"),
        );
        assert.ok(hidden >= 0);
        const ready = runtime.nextOutput();
        click(card, hidden, 12);
        const panel = await ready;
        assert.match(output(panel), /nested-line-0\b/);
        panel.handleInput?.("\x1b[F");
        assert.match(output(panel), /newest-nested-token/);
        panel.handleInput?.("\x1b");
        // The call has no arguments, so an expanded parent is recognized by its missing hint.
        const parent = output(card);
        assert.match(
            parent,
            /nested-line-39/,
            "Browsing a child output preserves its expanded parent",
        );
        assert.doesNotMatch(parent, /click to show more/);
        runtime.emit("tool_execution_end", {
            toolCallId: "child",
            parentToolCallId: "tool-0",
            isError: true,
            result: {
                content: [{ type: "text", text: "nested-build-failed" }],
                details: undefined,
            },
        });
        assert.match(output(card), /1 failed/);
        assert.match(output(card), /nested-build-failed/);
    });
}

test("thinking uses live summary stages, reserves its initial row and retains all expanded content", (t) => {
    const runtime = fixture(t, "on", true);
    const initial = {
        role: "assistant",
        api: "openai-codex-responses",
        content: [{ type: "thinking", thinking: "" }],
        timestamp: 2468,
    } as AssistantMessage;
    const assistant = new AssistantMessageComponent(initial, true, getMarkdownTheme());
    runtime.chat.addChild(assistant);
    runtime.emit("message_update", {
        message: initial,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    const expectedRow = lines(assistant).findIndex((line) => /Thinking/.test(line));
    assert.doesNotMatch(output(assistant), /click to show more/);
    const first = structuredClone(initial);
    first.content[0] = { type: "thinking", thinking: "**First stage**\n\nfirst-stage-body" };
    runtime.emit("message_update", {
        message: first,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assistant.updateContent(first, true);
    assert.equal(
        lines(assistant).findIndex((line) => /Thinking/.test(line)),
        expectedRow,
    );
    const latest = structuredClone(first);
    latest.content[0] = {
        type: "thinking",
        thinking:
            "**First stage**\n\nfirst-stage-body\n**Latest stage**\n\n```mermaid\ngraph TD; newest-thinking-token",
        thinkingSignature: JSON.stringify({
            type: "reasoning",
            summary: [{ type: "summary_text", text: "**First stage**\n\nfirst-stage-body" }],
        }),
    };
    runtime.emit("message_update", {
        message: latest,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assistant.updateContent(latest, true);
    const native = runtime.tui as TuiAltScreen;
    native.renderNow();
    const actual = native.getScreenLines().map(stripVTControlCharacters).join("\n");
    assert.match(actual, /Latest stage/);
    assert.match(actual, /newest-thinking-token/);
    assert.doesNotMatch(actual, /first-stage-body/);
    clickDisclosure(assistant);
    assert.match(output(assistant), /first-stage-body/);
    assert.match(output(assistant), /newest-thinking-token/);
    const completed = structuredClone(latest);
    completed.content[0] = {
        type: "thinking",
        thinking: "**First stage**\n\nfirst-stage-body\n**Latest stage**\n\nnewest-thinking-token",
        thinkingSignature: JSON.stringify({
            type: "reasoning",
            summary: [{ type: "summary_text", text: "**Final stage**\n\ncanonical-final-body" }],
        }),
    };
    runtime.emit("message_update", {
        message: completed,
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    });
    runtime.emit("message_end", { message: completed });
    assistant.updateContent(completed, false);
    click(assistant, 2, 100);
    assert.match(output(assistant), /Final stage/);
    assert.match(output(assistant), /canonical-final-body/);
});

test("thinking tokens survive late native refreshes and final messages remain authoritative", (t) => {
    const runtime = fixture(t);
    const initial = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "first-token" }],
        timestamp: 3579,
    } as AssistantMessage;
    const assistant = new AssistantMessageComponent(initial, true, getMarkdownTheme());
    runtime.chat.addChild(assistant);
    runtime.emit("message_update", {
        message: initial,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    const latest = structuredClone(initial);
    latest.content[0] = { type: "thinking", thinking: "first-token\nnewest-token" };
    runtime.emit("message_update", {
        message: latest,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assistant.updateContent(initial, true);
    assert.match(output(assistant), /newest-token/);
    clickDisclosure(assistant);
    const expanded = structuredClone(latest);
    expanded.content[0] = {
        type: "thinking",
        thinking: "first-token\nnewest-token\nexpanded-newest-token",
    };
    runtime.emit("message_update", {
        message: expanded,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    });
    assistant.updateContent(latest, true);
    assert.match(output(assistant), /expanded-newest-token/);
    assert.doesNotMatch(output(assistant), /click to show more/);
    const completed = structuredClone(expanded);
    completed.content[0] = { type: "thinking", thinking: "authoritative-final-thinking" };
    runtime.emit("message_end", { message: completed });
    assistant.updateContent(completed, false);
    assert.match(output(assistant), /authoritative-final-thinking/);
    assert.doesNotMatch(output(assistant), /expanded-newest-token/);
});

test("thinking run assembly preserves interleaved native prose, streamed bodies and native errors", (t) => {
    const runtime = fixture(t);
    const initial = {
        role: "assistant",
        content: [
            { type: "thinking", thinking: "earlier-thinking" },
            { type: "text", text: "Native assistant prose" },
            { type: "thinking", thinking: "" },
        ],
        timestamp: 4680,
    } as AssistantMessage;
    const assistant = new AssistantMessageComponent(initial, true, getMarkdownTheme());
    runtime.chat.addChild(assistant);
    runtime.emit("message_update", {
        message: initial,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 2 },
    });
    const before = output(assistant);
    assert.match(before, /Native assistant prose/);
    assert.match(before, /earlier-thinking/);
    const expectedRow = lines(assistant).findLastIndex((line) => /Thinking/.test(line));
    const latest = structuredClone(initial);
    latest.content[2] = { type: "thinking", thinking: "latest-thinking-after-prose" };
    runtime.emit("message_update", {
        message: latest,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 2 },
    });
    assistant.updateContent(latest, true);
    const actual = output(assistant);
    assert.equal(
        lines(assistant).findLastIndex((line) => /Thinking/.test(line)),
        expectedRow,
    );
    assert.equal((actual.match(/Native assistant prose/g) ?? []).length, 1);
    assert.equal((actual.match(/earlier-thinking/g) ?? []).length, 1);
    assert.equal((actual.match(/latest-thinking-after-prose/g) ?? []).length, 1);
    const completed = {
        ...latest,
        stopReason: "error" as const,
        errorMessage: "provider-stream-error",
    };
    runtime.emit("message_end", { message: completed });
    assistant.updateContent(completed, false);
    assert.match(output(assistant), /Error: provider-stream-error/);
    runtime.mounted.dispose();
    assistant.setHideThinkingBlock(false);
    assert.match(output(assistant), /Native assistant prose/);
    assert.match(output(assistant), /latest-thinking-after-prose/);
});

test("codemode shows live nested calls despite empty or stale partial metadata and advances moon-phase marks at the minimum interval", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3000 });
    const runtime = fixture(t);
    const parent = "tool-0";
    const card = runtime.add(
        "codemode",
        { code: "text(await tools.read({ path: 'live.ts' }));" },
        { content: [], details: { calls: [] } },
        true,
        true,
    );
    runtime.emit("tool_execution_start", { toolCallId: parent, toolName: "codemode", args: {} });
    assert.match(output(card), /1 call · 1 running/);
    assert.doesNotMatch(output(card), /tools\.read|Preparing script/, "No script preview");
    assert.equal(
        lines(card).filter((row) => row.trim()).length,
        1,
        "Only the heading row shows until the first nested call",
    );
    runtime.emit("tool_execution_start", {
        toolCallId: "nested-read",
        parentToolCallId: parent,
        toolName: "read",
        args: { path: "live.ts" },
    });
    // Mocked time 3000ms at the 300ms minimum interval lands on the third phase.
    assert.match(output(card), /└ ◑ read {2}live\.ts$/m);
    assert.doesNotMatch(output(card), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    assert.doesNotMatch(output(card), /read.*running/, "Running rows show a mark, not a word");
    const first = output(card);
    t.mock.timers.tick(150);
    assert.equal(output(card), first);
    t.mock.timers.tick(150);
    assert.match(output(card), /└ ◒ read {2}live\.ts$/m, "The mark advances one phase");
    runtime.emit("tool_execution_end", {
        toolCallId: "nested-read",
        parentToolCallId: parent,
        isError: false,
        durationMs: 60,
    });
    assert.match(output(card), /● read {2}live\.ts · 60ms/);
    const partial = {
        content: [],
        details: { calls: [{ name: "read", args: '{"path":"live.ts"}', status: "running" }] },
        isError: false,
    };
    card.updateResult(partial, true);
    runtime.emit("tool_execution_start", {
        toolCallId: "nested-bash",
        parentToolCallId: parent,
        toolName: "bash",
        args: { command: "npm run build" },
    });
    const active = output(card);
    assert.match(active, /2 calls · 1 running/);
    assert.match(active, /● read {2}live\.ts/);
    assert.match(active, new RegExp(`${RUNNING_MARK} bash {2}npm run build`));
    assert.equal(
        (active.match(/read  live.ts/g) ?? []).length,
        1,
        "Metadata and execution events describe one call",
    );
    runtime.emit("tool_execution_end", {
        toolCallId: "nested-bash",
        parentToolCallId: parent,
        isError: true,
        durationMs: 90,
    });
    assert.match(output(card), /2 calls · 1 failed/);
    assert.doesNotMatch(output(card), /running/);
    assert.match(output(card), /● bash {2}npm run build · failed · 90ms/);
});

for (const mode of ["on", "compact"] as const) {
    test(`${mode} streaming codemode keeps its collapsed card script-free and only adds call rows`, (t) => {
        const runtime = fixture(t, mode);
        const parent = "tool-0";
        const script = [
            "const listing = await tools.bash({ command: 'ls -la' });",
            "const source = await tools.read({ path: 'src/index.ts' });",
            "text(listing + source);",
        ].join("\n");
        // Raw code or the empty-script placeholder would flash before the call tree replaces it.
        const scriptPreview = /const |tools\.|text\(|Preparing script/;
        // Status marks and durations change in place; the call name and summary identify the row.
        const callLabel = (row: string) =>
            row.replace(/^\s*[├└] \S /, "").replace(/ · \d+ms$/, "");
        const card = runtime.stream("codemode");
        const frames: string[][] = [];
        const capture = () => {
            const rows = lines(card);
            const previous = frames.at(-1) ?? [];
            assert.doesNotMatch(
                rows.join("\n"),
                scriptPreview,
                "The collapsed card never previews the script",
            );
            assert.ok(
                rows.length >= previous.length,
                `The card shrank from ${previous.length} to ${rows.length} rows`,
            );
            assert.match(rows[1]!, /codemode/);
            for (const [index, row] of previous.entries())
                if (index >= 2)
                    assert.equal(callLabel(rows[index]!), callLabel(row), `Row ${index} moved`);
            frames.push(rows);
            return rows;
        };
        capture();
        // The first update can arrive before any code has streamed.
        for (const code of ["", "const lis", script.slice(0, 70), script]) {
            card.updateArgs({ code });
            capture();
        }
        card.setArgsComplete();
        card.markExecutionStarted();
        runtime.emit("tool_execution_start", {
            toolCallId: parent,
            toolName: "codemode",
            args: { code: script },
        });
        assert.equal(capture().length, 2, "Only the heading follows the leading spacer");
        const nested = [
            { id: "nested-bash", name: "bash", args: { command: "ls -la" } },
            { id: "nested-read", name: "read", args: { path: "src/index.ts" } },
        ];
        for (const call of nested) {
            runtime.emit("tool_execution_start", {
                toolCallId: call.id,
                parentToolCallId: parent,
                toolName: call.name,
                args: call.args,
            });
            capture();
            runtime.emit("tool_execution_end", {
                toolCallId: call.id,
                parentToolCallId: parent,
                isError: false,
                durationMs: 20,
            });
            capture();
        }
        card.updateResult({
            content: [
                { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\ndone" },
            ],
            details: {
                calls: nested.map((call) => ({
                    name: call.name,
                    args: JSON.stringify(call.args),
                    status: "done",
                })),
            },
            isError: false,
        });
        runtime.emit("tool_execution_end", { toolCallId: parent, isError: false });
        const actual = capture().slice(2).map(callLabel);
        const expected = ["bash  ls -la", "read  src/index.ts"];
        assert.deepEqual(actual, expected);
        card.setExpanded(true);
        const expanded = output(card);
        assert.match(expanded, SCRIPT_LABEL);
        for (const row of script.split("\n")) assert.ok(expanded.includes(row), row);
    });
}

test("expanded tool and group hidden rows open wrapped output and scrolling reaches its final line", async (t) => {
    for (const mode of ["on", "compact"] as const) {
        const runtime = fixture(t, mode);
        setConfig({ ...config, expandedOutputMaxLines: 3 });
        const content = [
            ...Array.from(
                { length: 7000 },
                (_, index) => `output-${index}: ${"payload ".repeat(15)}`,
            ),
            `${"x".repeat(500)}far-column-sentinel`,
        ].join("\n");
        const card = runtime.add(
            "read",
            { path: "large.log" },
            { content: [{ type: "text", text: content }], details: undefined },
        );
        if (mode === "compact") runtime.add("bash", { command: "echo other" }, undefined, false);
        const target = runtime.target(card);
        clickDisclosure(target);
        assert.doesNotMatch(output(target), /output-6999/);
        const rendered = lines(target);
        const hidden = rendered.findIndex((line) =>
            line.includes("more output · click to view full output"),
        );
        assert.ok(hidden >= 0);
        const ready = runtime.nextOutput();
        click(target, hidden, rendered[hidden]!.indexOf("click to view"));
        assert.ok(
            runtime.outputPanel(),
            "The hidden-output row opens a browser instead of collapsing its parent",
        );
        const panel = await ready;
        const panelRows = lines(panel);
        const footerRow = panelRows.findIndex((row) => row.includes("Full output ·"));
        assert.equal(
            footerRow,
            panelRows.length - 2,
            "Key hints occupy the bottom footer below output",
        );
        assert.match(panelRows[footerRow - 1]!, /^├─+┤$/);
        assert.match(panelRows[footerRow]!, /c to copy · Esc to close/);
        assert.doesNotMatch(panelRows[footerRow]!, /\[|\]/);
        assert.doesNotMatch(panelRows[1]!, /↑↓|PgUp|copy|Esc/);
        assert.match(
            output(target),
            INPUT_LABEL,
            "Opening hidden output keeps the expanded tool panel open",
        );
        assert.match(output(panel), /output-0/);
        panel.handleInput?.("\x1b[F");
        assert.match(output(panel), /output-6999/);
        assert.match(output(panel), /7001 lines/);
        assert.match(output(panel), /far-column-sentinel/);
        const wrappedTail = output(panel);
        panel.handleInput?.("\x1b[C");
        panel.handleInput?.("\x1b[D");
        assert.equal(output(panel), wrappedTail, "Wrapped output has no horizontal navigation");
        panel.handleInput?.("\x1b[H");
        assert.match(output(panel), /output-0/);
        for (const width of [1, 2, 8, 20, 40, 120])
            for (const row of panel.render(width)) assert.ok(visibleWidth(row) <= width);
        panel.handleInput?.("\x1b");
        assert.equal(runtime.outputPanel(), undefined);
        assert.deepEqual(runtime.notices, []);
        click(target, 3, 100);
        assert.doesNotMatch(output(target), INPUT_LABEL);
        runtime.mounted.dispose();
    }
});

test("hidden edit and write diff rows browse changes outside the inline preview", async (t) => {
    const runtime = fixture(t);
    setConfig({ ...config, expandedPreviewMaxLines: 8 });
    const before = Array.from({ length: 120 }, (_, index) => `old_${index}`).join("\n");
    const after = Array.from({ length: 120 }, (_, index) => `new_${index}`).join("\n");
    for (const name of ["edit", "write"] as const) {
        const details =
            name === "edit"
                ? {
                      diff: [
                          ...before.split("\n").map((line, index) => `-${index + 1} ${line}`),
                          ...after.split("\n").map((line, index) => `+${index + 1} ${line}`),
                      ].join("\n"),
                  }
                : { luneThemeWrite: { previousContent: before, fileExistedBeforeWrite: true } };
        const card = runtime.add(
            name,
            { path: "file.ts", content: after },
            { content: [{ type: "text", text: "changed" }], details },
        );
        clickDisclosure(card);
        const rendered = lines(card);
        const hidden = rendered.findIndex((line) =>
            line.includes("more diff · click to view full output"),
        );
        assert.ok(hidden >= 0, name);
        const ready = runtime.nextOutput();
        click(card, hidden, 40);
        assert.ok(runtime.outputPanel(), "The diff footer opens a full-output browser");
        const panel = await ready;
        panel.handleInput?.("\x1b[F");
        assert.match(output(panel), /new_119/);
        panel.handleInput?.("\x1b[H");
        assert.match(output(panel), /old_0/);
        panel.handleInput?.("\x1b");
        click(card, 3, 100);
        assert.doesNotMatch(output(card), INPUT_LABEL);
    }
});

test("archived native output is loaded in full and disposal closes its output overlay", async (t) => {
    const runtime = fixture(t);
    const directory = await mkdtemp(join(tmpdir(), "lune-full-output-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fullOutputPath = join(directory, "output.log");
    await writeFile(
        fullOutputPath,
        "native archive first\n" + "full native output\n".repeat(100) + "native archive last",
    );
    const card = runtime.add(
        "bash",
        { command: "node runner.mjs" },
        { content: [{ type: "text", text: "short native preview" }], details: { fullOutputPath } },
    );
    clickDisclosure(card);
    const rendered = lines(card);
    const hidden = rendered.findIndex((line) =>
        line.includes("more output · click to view full output"),
    );
    const ready = runtime.nextOutput();
    click(card, hidden, 40);
    assert.ok(runtime.outputPanel(), "Archived output opens a full-output browser");
    const panel = await ready;
    assert.match(output(panel), /native archive first/);
    assert.doesNotMatch(output(panel), /short native preview/);
    panel.handleInput?.("\x1b[F");
    assert.match(output(panel), /native archive last/);
    runtime.mounted.dispose();
    assert.equal(runtime.outputPanel(), undefined);
});

test("native fullscreen motion clears disclosure hover after leaving a hint or the transcript", async (t) => {
    const runtime = fixture(t, "on", true);
    const card = runtime.add("read");
    const baseline = card.render(120).join("\n");
    runtime.tui.renderNow();
    const rendered = lines(runtime.chat);
    const row = rendered.findIndex((line) => line.includes("click to show more"));
    const column = rendered[row]!.indexOf("click to show more");
    runtime.terminalInput(`\x1b[<35;${column + 1};${row + 1}M`);
    assert.notEqual(
        card.render(120).join("\n"),
        baseline,
        "Native mouse dispatch highlights the hint",
    );
    runtime.terminalInput("\x1b[<35;119;39M");
    await Promise.resolve();
    assert.equal(
        card.render(120).join("\n"),
        baseline,
        "Moving into empty viewport space removes the highlight",
    );
    runtime.terminalInput(`\x1b[<35;${column + 1};${row + 1}M`);
    assert.notEqual(card.render(120).join("\n"), baseline);
    runtime.terminalInput("\x1b[<35;4;3M");
    await Promise.resolve();
    assert.equal(
        card.render(120).join("\n"),
        baseline,
        "Moving onto non-clickable card content removes the highlight",
    );
});

test("native fullscreen clicks open a grouped output browser, its keys scroll, and content clicks close the group", async (t) => {
    const runtime = fixture(t, "compact", true);
    setConfig({ ...config, expandedOutputMaxLines: 3 });
    const text = Array.from({ length: 100 }, (_, index) => `native-row-${index}`).join("\n");
    runtime.add(
        "read",
        { path: "native.log" },
        { content: [{ type: "text", text }], details: undefined },
    );
    assert.ok(runtime.tui instanceof TuiAltScreen);
    const native = runtime.tui;
    const sendClick = (label: string) => {
        native.renderNow();
        const screen = native.getScreenLines().map(stripVTControlCharacters);
        const row = screen.findIndex((line) => line.includes(label));
        assert.ok(row >= 0, label);
        const column = screen[row]!.indexOf(label);
        runtime.terminalInput(`\x1b[<0;${column + 1};${row + 1}M`);
        runtime.terminalInput(`\x1b[<0;${column + 1};${row + 1}m`);
    };
    sendClick("click to show more");
    assert.match(output(runtime.chat), INPUT_LABEL);
    const ready = runtime.nextOutput();
    sendClick("more output · click to view full output");
    assert.ok(runtime.outputPanel());
    const panel = await ready;
    native.renderNow();
    const screen = native.getScreenLines().map(stripVTControlCharacters);
    const hintRow = screen.findIndex((line) => line.includes("Esc to close"));
    const column = screen[hintRow]!.indexOf("Esc to close");
    const panelWidth = visibleWidth(screen[hintRow - 1]!.trim());
    const baseline = panel.render(panelWidth).join("\n");
    runtime.terminalInput(`\x1b[<35;${column + 2};${hintRow + 1}M`);
    assert.equal(
        panel.render(panelWidth).join("\n"),
        baseline,
        "Keyboard hints have no hover styling",
    );
    runtime.terminalInput("\x1b[<35;1;1M");
    await Promise.resolve();
    assert.equal(
        panel.render(panelWidth).join("\n"),
        baseline,
        "Moving outside the panel keeps plain keyboard hints unchanged",
    );
    runtime.terminalInput("\x1b[F");
    native.renderNow();
    assert.match(native.getScreenLines().map(stripVTControlCharacters).join("\n"), /native-row-99/);
    sendClick("Esc to close");
    assert.equal(runtime.outputPanel(), panel, "Clicking a keyboard hint has no action");
    runtime.terminalInput("\x1b");
    assert.equal(runtime.outputPanel(), undefined);
    assert.match(output(runtime.chat), INPUT_LABEL);
    sendClick("native-row-0");
    assert.doesNotMatch(output(runtime.chat), INPUT_LABEL);
});

test("mouse-disabled tool cards never fall through to Pi's whole-card expansion and disposal retires hooks", (t) => {
    const runtime = fixture(t);
    const card = runtime.add("read");
    setConfig({ ...config, fullscreenMouse: false });
    const expected = output(card);
    clickDisclosure(card);
    click(card, 1, 1);
    assert.equal(output(card), expected);
    runtime.mounted.dispose();
    assert.equal(runtime.widgets.size, 0);
    assert.equal(
        [...runtime.listeners.values()].reduce((count, values) => count + values.size, 0),
        0,
    );
});

test("a mounted host publishes the activity renderer, which renders the host's expand key, and dispose retires it", (t) => {
    const runtime = fixture(t);

    const published = (globalThis as Record<symbol, unknown>)[LUNE_THEME_RENDERER] as
        | LuneThemeRenderer
        | undefined;
    setConfig({ ...config, previewLines: 0 });
    const activity = published?.renderActivity(
        { title: "Agents", entries: [{ name: "run", status: "done", output: "a\nb" }] },
        { expanded: false },
        runtime.theme,
    );
    const rendered = activity ? lines(activity) : [];
    runtime.mounted.dispose();
    runtime.mounted.dispose();

    assert.equal(published?.version, 1);
    assert.deepEqual(rendered.slice(-1), ["       … 2 lines · ctrl+o to expand"]);
    assert.equal(LUNE_THEME_RENDERER in globalThis, false);
});

type Expandable = Component & { setExpanded(expanded: boolean): void };
const assistantStart = { message: { role: "assistant" } };

test("a group or card expanded by Pi's own toggle survives the next assistant message", (t) => {
    const runtime = fixture(t);
    const single = runtime.add("ls");
    runtime.chat.addChild(new Text("Separator", 0, 0));
    const first = runtime.add("read");
    runtime.add("bash", { command: "echo done" }, undefined, false);
    const group = runtime.target(first) as Expandable;

    (single as unknown as Expandable).setExpanded(true);
    group.setExpanded(true);
    runtime.emit("message_start", assistantStart);

    assert.match(output(single), INPUT_LABEL);
    assert.match(output(group), INPUT_LABEL);
});

test("a click-opened card stays open at a text start and at the next assistant message", (t) => {
    const runtime = fixture(t);
    const card = runtime.add("read");
    clickDisclosure(card);
    assert.match(output(card), INPUT_LABEL);

    runtime.emit("message_update", {
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    assert.match(output(card), INPUT_LABEL);

    runtime.emit("message_start", assistantStart);
    assert.match(output(card), INPUT_LABEL);
});

function emitNewRound(runtime: ReturnType<typeof fixture>) {
    const message = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
        timestamp: 4242,
    } as AssistantMessage;
    runtime.chat.addChild(new AssistantMessageComponent(message, true, getMarkdownTheme()));
    runtime.emit("message_start", { message });
    for (const assistantMessageEvent of [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "plan" },
        { type: "thinking_end", contentIndex: 0, content: "plan" },
        { type: "text_start", contentIndex: 1 },
    ])
        runtime.emit("message_update", { message, assistantMessageEvent });
}

test("a click-opened card or group stays expanded through a new round's thinking and text events", (t) => {
    const runtime = fixture(t);
    const card = runtime.add("ls");
    clickDisclosure(card);
    const first = runtime.add("read");
    runtime.add("bash", { command: "echo done" }, undefined, false);
    const group = runtime.target(first);
    clickDisclosure(group);
    assert.match(output(group), INPUT_LABEL);

    emitNewRound(runtime);
    assert.match(output(group), INPUT_LABEL);

    const lone = runtime.add("find");
    clickDisclosure(runtime.target(lone));
    assert.match(output(lone), INPUT_LABEL);
    emitNewRound(runtime);
    assert.match(output(lone), INPUT_LABEL);
});

test("a group formed around a click-opened card starts open and stays open at the next assistant message", (t) => {
    const runtime = fixture(t);
    const first = runtime.add("read");
    clickDisclosure(first);
    assert.match(output(first), INPUT_LABEL);

    runtime.add("bash", { command: "echo done" }, undefined, false);
    const group = runtime.target(first);
    const opened = output(group);
    assert.notEqual(group, first);
    assert.match(opened, INPUT_LABEL);
    assert.doesNotMatch(opened, /click to show more/);

    runtime.emit("message_start", assistantStart);
    assert.match(output(group), INPUT_LABEL);
    assert.doesNotMatch(output(group), /click to show more/);
});

test("opening another card collapses a group that inherited its open card", (t) => {
    const runtime = fixture(t);
    const first = runtime.add("read");
    clickDisclosure(first);
    runtime.add("bash", { command: "echo done" }, undefined, false);
    const group = runtime.target(first);
    assert.match(output(group), INPUT_LABEL);

    const other = runtime.add("ls");
    clickDisclosure(runtime.target(other));

    assert.match(output(group), /click to show more/);
    assert.doesNotMatch(output(group), INPUT_LABEL);
    assert.match(output(other), INPUT_LABEL);
});

function activityFixture(t: TestContext) {
    const runtime = fixture(t);
    setConfig({ ...config, previewLines: 3 });
    const published = (globalThis as Record<symbol, unknown>)[
        LUNE_THEME_RENDERER
    ] as LuneThemeRenderer;
    const activity = {
        title: "Agents",
        entries: [
            {
                name: "run",
                status: "done" as const,
                output: Array.from({ length: 6 }, (_, index) => `out ${index + 1}`).join("\n"),
            },
        ],
    };
    const render = (key: object | undefined, expanded = false) =>
        published.renderActivity(activity, { expanded, key }, runtime.theme);
    return { runtime, render };
}
function mouse(
    component: Component,
    type: "click" | "move",
    row: number,
    column: number,
    button: "left" | "right" = "left",
) {
    const width = 120;
    return component.handleMouse?.({
        type,
        button,
        x: column,
        y: row,
        screenX: column,
        screenY: row,
        width,
        height: component.render(width).length,
    } as TuiMouseEvent);
}
function hintAt(component: Component, pattern: RegExp) {
    const rendered = lines(component);
    const row = rendered.findIndex((line) => pattern.test(line));
    return { row, column: rendered[row]?.search(pattern) ?? -1 };
}

test("a keyed activity card shows clickable hints instead of the keyboard hint", (t) => {
    const { render } = activityFixture(t);

    const actual = lines(render({}));

    assert.match(actual[0]!, /^● Agents.*click to show more$/);
    assert.ok(actual.some((row) => /… 3 earlier lines$/.test(row)));
    assert.ok(actual.every((row) => !/ctrl\+o/.test(row)));
});

test("clicking the heading hint expands a keyed card and clicking its content collapses it", (t) => {
    const { render } = activityFixture(t);
    const card = render({});
    const { row, column } = hintAt(card, /click to show more/);

    const opened = mouse(card, "click", row, column);

    assert.equal(opened?.handled, true);
    assert.match(output(card), /out 1\b/);
    assert.doesNotMatch(output(card), /click to show more|earlier lines/);

    const closed = mouse(card, "click", 1, 5);
    assert.equal(closed?.handled, true);
    assert.doesNotMatch(output(card), /out 1\b/);
    assert.match(output(card), /click to show more/);
});

test("clicking the earlier-lines row expands a keyed card", (t) => {
    const { render } = activityFixture(t);
    const card = render({});
    const { row, column } = hintAt(card, /… 3 earlier lines/);

    const result = mouse(card, "click", row, column);

    assert.equal(result?.handled, true);
    assert.match(output(card), /out 1\b/);
});

test("clicks away from the hints, with other buttons or with mouse disabled do not expand a keyed card", (t) => {
    const { render } = activityFixture(t);
    const card = render({});
    const baseline = output(card);
    const { row, column } = hintAt(card, /click to show more/);

    const onEntry = mouse(card, "click", 1, 5);
    const rightButton = mouse(card, "click", row, column, "right");
    setConfig({ ...config, fullscreenMouse: false });
    const disabled = mouse(card, "click", row, column);

    assert.equal(onEntry, undefined);
    assert.equal(rightButton, undefined);
    assert.equal(disabled, undefined);
    assert.equal(output(card), baseline);
});

test("hovering a hint highlights it with the accent color and moving away restores it", (t) => {
    const { runtime, render } = activityFixture(t);
    const card = render({});
    const rawHint = (rows: string[]) => rows[0]!.slice(rows[0]!.indexOf("click to show more") - 20);
    const accent = runtime.theme.fg("accent", "click to show more");
    const dim = runtime.theme.fg("dim", "click to show more");
    const { row, column } = hintAt(card, /click to show more/);
    assert.ok(rawHint(card.render(120)).includes(dim));

    const over = mouse(card, "move", row, column);
    const hovered = card.render(120);
    const off = mouse(card, "move", 1, 5);
    const restored = card.render(120);

    assert.equal(over?.handled, true);
    assert.equal(over?.render, true);
    assert.ok(hovered[0]!.endsWith(accent));
    assert.equal(off?.render, true);
    assert.ok(restored[0]!.endsWith(dim));
});

test("a card rebuilt with the same key stays open, another key and a changed host value do not", (t) => {
    const { render } = activityFixture(t);
    const key = {};
    const first = render(key);
    const { row, column } = hintAt(first, /click to show more/);
    mouse(first, "click", row, column);

    const sameKey = output(render(key));
    const otherKey = output(render({}));
    const hostOpened = output(render(key, true));
    const hostClosed = output(render(key, false));

    assert.match(sameKey, /out 1\b/);
    assert.doesNotMatch(otherKey, /out 1\b/);
    assert.match(otherKey, /click to show more/);
    assert.match(hostOpened, /out 1\b/);
    assert.doesNotMatch(hostClosed, /out 1\b/);
});

test("opening another card collapses a click-opened activity card, an assistant message does not", (t) => {
    const { runtime, render } = activityFixture(t);
    const key = {};
    const open = () => {
        const card = render(key);
        const { row, column } = hintAt(card, /click to show more/);
        mouse(card, "click", row, column);
        return card;
    };

    const first = open();
    assert.match(output(first), /out 1\b/);
    const other = runtime.add("ls");
    clickDisclosure(runtime.target(other));
    assert.doesNotMatch(output(render(key)), /out 1\b/);

    const second = open();
    assert.match(output(second), /out 1\b/);
    runtime.emit("message_start", assistantStart);
    assert.match(output(render(key)), /out 1\b/);
});

test("an activity card that Pi's expand toggle took over is not closed by opening another card", (t) => {
    const { runtime, render } = activityFixture(t);
    const key = {};
    const card = render(key);
    const { row, column } = hintAt(card, /click to show more/);
    mouse(card, "click", row, column);

    assert.match(output(render(key, true)), /out 1\b/);
    const other = runtime.add("ls");
    clickDisclosure(runtime.target(other));

    assert.match(output(render(key, true)), /out 1\b/);
});

test("an activity card without a key has no click targets", (t) => {
    const { render } = activityFixture(t);
    const card = render(undefined);

    const result = mouse(card, "click", 0, 5);

    assert.equal(result, undefined);
    assert.doesNotMatch(output(card), /click to show more/);
    assert.match(output(card), /… 3 earlier lines · ctrl\+o to expand/);
});

const FULL_OUTPUT_ROW = "… more output · click to view full output";

function numbered(prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

function expandedActivity(
    t: TestContext,
    entries: { name: string; output: string; fullOutputPath?: string }[],
    maxLines: number,
) {
    const runtime = fixture(t);
    setConfig({ ...config, previewLines: 3, expandedOutputMaxLines: maxLines });
    const published = (globalThis as Record<symbol, unknown>)[
        LUNE_THEME_RENDERER
    ] as LuneThemeRenderer;
    const activity = {
        title: "Agents",
        entries: entries.map((entry) => ({ ...entry, status: "done" as const })),
    };
    const key = {};
    const render = (options: { key?: object } = { key }) =>
        published.renderActivity(activity, { expanded: false, ...options }, runtime.theme);
    const card = render();
    const { row, column } = hintAt(card, /click to show more/);
    mouse(card, "click", row, column);
    return { runtime, card, render };
}

test("an expanded keyed card shows only the last expandedOutputMaxLines of output and a full-output row right after it", (t) => {
    const { card } = expandedActivity(t, [{ name: "run", output: numbered("out", 6) }], 4);

    const actual = lines(card);

    const last = actual.findIndex((row) => /out 6\b/.test(row));
    assert.deepEqual(
        actual.filter((row) => /out \d/.test(row)).map((row) => row.match(/out \d/)![0]),
        ["out 3", "out 4", "out 5", "out 6"],
    );
    assert.ok(actual[last + 1]!.includes(FULL_OUTPUT_ROW));
    assert.equal(actual.filter((row) => row.includes(FULL_OUTPUT_ROW)).length, 1);
});

test("an expanded keyed card whose output fits shows no full-output row", (t) => {
    const { card } = expandedActivity(t, [{ name: "run", output: numbered("out", 6) }], 6);

    const actual = output(card);

    assert.match(actual, /out 1\b/);
    assert.doesNotMatch(actual, /click to view full output/);
});

test("with two entries only the one whose output is cut gets a full-output row, placed after its own output", (t) => {
    const { card } = expandedActivity(
        t,
        [
            { name: "alpha", output: numbered("a", 6) },
            { name: "beta", output: numbered("b", 2) },
        ],
        3,
    );

    const actual = lines(card);

    const lastAlpha = actual.findIndex((row) => /a 6\b/.test(row));
    const beta = actual.findIndex((row) => /beta/.test(row));
    assert.equal(actual.filter((row) => row.includes(FULL_OUTPUT_ROW)).length, 1);
    assert.ok(actual[lastAlpha + 1]!.includes(FULL_OUTPUT_ROW));
    assert.equal(beta, lastAlpha + 2);
    assert.match(output(card), /b 1\b[\s\S]*b 2\b/);
});

test("clicking the full-output row opens the complete output under the entry's title and keeps the card expanded", async (t) => {
    const full = numbered("out", 6);
    const { runtime, card } = expandedActivity(t, [{ name: "run", output: full }], 3);
    const { row, column } = hintAt(card, /click to view full output/);
    const ready = runtime.nextOutput();

    const result = mouse(card, "click", row, column);

    assert.equal(result?.handled, true);
    assert.ok(runtime.outputPanel());
    const panel = await ready;
    assert.match(output(panel), /run · full output/);
    assert.match(output(panel), /out 1\b[\s\S]*out 6\b/);
    assert.match(output(card), /out 4\b/);
    assert.match(output(card), /click to view full output/);
    assert.doesNotMatch(output(card), /click to show more/);
});

test("clicking an expanded card away from its full-output row still collapses it", (t) => {
    const { runtime, card } = expandedActivity(t, [{ name: "run", output: numbered("out", 6) }], 3);

    const result = mouse(card, "click", 1, 5);

    assert.equal(result?.handled, true);
    assert.equal(runtime.outputPanel(), undefined);
    assert.match(output(card), /click to show more/);
    assert.doesNotMatch(output(card), /click to view full output/);
});

test("hovering one entry's full-output row lights only that row and moving away restores it", (t) => {
    const { runtime, card } = expandedActivity(
        t,
        [
            { name: "alpha", output: numbered("a", 6) },
            { name: "beta", output: numbered("b", 6) },
        ],
        3,
    );
    const accent = runtime.theme.fg("accent", FULL_OUTPUT_ROW);
    const dim = runtime.theme.fg("dim", FULL_OUTPUT_ROW);
    const rows = lines(card);
    const first = rows.findIndex((row) => row.includes(FULL_OUTPUT_ROW));
    const second = rows.findIndex((row, index) => index > first && row.includes(FULL_OUTPUT_ROW));
    const count = (text: string, part: string) => text.split(part).length - 1;
    assert.equal(count(card.render(120).join("\n"), dim), 2);

    const over = mouse(card, "move", second, rows[second]!.indexOf("click to view"));
    const hovered = card.render(120);
    const off = mouse(card, "move", 1, 5);
    const restored = card.render(120).join("\n");

    assert.equal(over?.render, true);
    assert.ok(hovered[first]!.includes(dim));
    assert.ok(hovered[second]!.includes(accent));
    assert.equal(count(hovered.join("\n"), accent), 1);
    assert.equal(off?.render, true);
    assert.equal(count(restored, accent), 0);
    assert.equal(count(restored, dim), 2);
});

test("hovering the earlier-lines row of a collapsed keyed card lights the heading hint with it", (t) => {
    const { runtime, render } = activityFixture(t);
    const card = render({});
    const accent = (text: string) => runtime.theme.fg("accent", text);
    const { row, column } = hintAt(card, /… 3 earlier lines/);

    const over = mouse(card, "move", row, column);
    const hovered = card.render(120);

    assert.equal(over?.render, true);
    assert.ok(hovered[0]!.endsWith(accent("click to show more")));
    assert.ok(hovered[row]!.includes(accent("… 3 earlier lines")));
});

test("an expanded card without a key shows all output and no full-output row", (t) => {
    const runtime = fixture(t);
    setConfig({ ...config, expandedOutputMaxLines: 3 });
    const published = (globalThis as Record<symbol, unknown>)[
        LUNE_THEME_RENDERER
    ] as LuneThemeRenderer;
    const card = published.renderActivity(
        {
            title: "Agents",
            entries: [{ name: "run", status: "done", output: numbered("out", 8) }],
        },
        { expanded: true },
        runtime.theme,
    );

    const actual = output(card);

    assert.match(actual, /out 1\b[\s\S]*out 8\b/);
    assert.doesNotMatch(actual, /click to view full output/);
});

test("with mouse disabled the full-output row neither opens the browser nor highlights", (t) => {
    const { runtime, card } = expandedActivity(t, [{ name: "run", output: numbered("out", 6) }], 3);
    const { row, column } = hintAt(card, /click to view full output/);
    const baseline = card.render(120).join("\n");
    setConfig({ ...config, fullscreenMouse: false });

    const move = mouse(card, "move", row, column);
    const click = mouse(card, "click", row, column);

    assert.equal(move, undefined);
    assert.equal(click, undefined);
    assert.equal(runtime.outputPanel(), undefined);
    assert.equal(card.render(120).join("\n"), baseline);
});

async function spilledLog(t: TestContext, content: string) {
    const directory = await mkdtemp(join(tmpdir(), "lune-activity-log-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "output.log");
    await writeFile(path, content);
    return path;
}

test("an expanded keyed card whose retained tail fits still shows the full-output row when the entry has a spilled log", async (t) => {
    const fullOutputPath = await spilledLog(t, "spilled log");
    const { card } = expandedActivity(
        t,
        [{ name: "run", output: numbered("out", 2), fullOutputPath }],
        6,
    );

    const actual = lines(card);

    const last = actual.findIndex((row) => /out 2\b/.test(row));
    assert.match(output(card), /out 1\b/);
    assert.ok(actual[last + 1]!.includes(FULL_OUTPUT_ROW));
});

test("clicking the full-output row of an entry with a spilled log browses the file instead of the tail", async (t) => {
    const fullOutputPath = await spilledLog(
        t,
        "log first line\n" + "log middle\n".repeat(80) + "log last line",
    );
    const { runtime, card } = expandedActivity(
        t,
        [{ name: "run", output: numbered("tail", 2), fullOutputPath }],
        6,
    );
    const { row, column } = hintAt(card, /click to view full output/);
    assert.ok(row >= 0, "The spilled log has a full-output row");
    const ready = runtime.nextOutput();

    const result = mouse(card, "click", row, column);

    assert.equal(result?.handled, true);
    assert.ok(runtime.outputPanel(), "The row opens a full-output browser");
    const panel = await ready;
    assert.match(output(panel), /run · full output/);
    assert.match(output(panel), /log first line/);
    assert.doesNotMatch(output(panel), /tail 1\b/);
    panel.handleInput?.("\x1b[F");
    assert.match(output(panel), /log last line/);
});

test("an unreadable spilled log reports the failure and closes the full-output browser", async (t) => {
    const fullOutputPath = join(tmpdir(), "lune-activity-log-missing", "absent.log");
    const { runtime, card } = expandedActivity(
        t,
        [{ name: "run", output: numbered("out", 2), fullOutputPath }],
        6,
    );
    const { row, column } = hintAt(card, /click to view full output/);
    assert.ok(row >= 0, "The spilled log has a full-output row");

    mouse(card, "click", row, column);
    for (let attempt = 0; attempt < 200 && runtime.notices.length === 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(runtime.notices.length, 1);
    assert.match(runtime.notices[0]!, /^Full output: .*ENOENT/);
    assert.equal(runtime.outputPanel(), undefined);
});

test("a keyless card with a spilled log shows no full-output row", async (t) => {
    const runtime = fixture(t);
    const fullOutputPath = await spilledLog(t, "spilled log");
    const published = (globalThis as Record<symbol, unknown>)[
        LUNE_THEME_RENDERER
    ] as LuneThemeRenderer;

    const card = published.renderActivity(
        {
            title: "Agents",
            entries: [{ name: "run", status: "done", output: numbered("out", 2), fullOutputPath }],
        },
        { expanded: true },
        runtime.theme,
    );

    assert.doesNotMatch(output(card), /click to view full output/);
});

test("a click-opened tool card is expanded again after Pi rebuilds the transcript", (t) => {
    const runtime = fixture(t);
    clickDisclosure(runtime.add("ls"));

    runtime.rebuildChat();
    const rebuilt = runtime.add("ls");

    assert.match(output(rebuilt), INPUT_LABEL);
    assert.doesNotMatch(output(rebuilt), /click to show more/);
});

test("a click-opened group re-forms expanded after a rebuild, whether it has two or three calls", (t) => {
    for (const extra of [1, 2]) {
        const runtime = fixture(t);
        const first = runtime.add("read");
        for (let index = 0; index < extra; index++)
            runtime.add("bash", { command: `echo ${index}` }, undefined, false);
        clickDisclosure(runtime.target(first));
        assert.match(output(runtime.target(first)), INPUT_LABEL);

        runtime.rebuildChat();
        const rebuiltFirst = runtime.add("read");
        for (let index = 0; index < extra; index++)
            runtime.add("bash", { command: `echo ${index}` }, undefined, false);

        const group = runtime.target(rebuiltFirst);
        assert.notEqual(group, rebuiltFirst, `${extra + 1} calls form a group`);
        assert.match(output(group), INPUT_LABEL);
        assert.doesNotMatch(output(group), /click to show more/);
    }
});

test("a tool card that was not click-opened stays collapsed after a rebuild", (t) => {
    const runtime = fixture(t);
    runtime.add("ls");

    runtime.rebuildChat();
    const rebuilt = runtime.add("ls");

    assert.match(output(rebuilt), /click to show more/);
    assert.doesNotMatch(output(rebuilt), INPUT_LABEL);
});

test("a tool card the user collapsed again stays collapsed after a rebuild", (t) => {
    const runtime = fixture(t);
    const card = runtime.add("ls");
    clickDisclosure(card);
    assert.match(output(card), INPUT_LABEL);
    clickDisclosure(card);
    assert.doesNotMatch(output(card), INPUT_LABEL);

    runtime.rebuildChat();
    const rebuilt = runtime.add("ls");

    assert.match(output(rebuilt), /click to show more/);
    assert.doesNotMatch(output(rebuilt), INPUT_LABEL);
});

test("opening another card after a rebuild collapses the reopened card", (t) => {
    const runtime = fixture(t);
    clickDisclosure(runtime.add("ls"));
    runtime.rebuildChat();
    const reopened = runtime.add("ls");
    assert.match(output(reopened), INPUT_LABEL);

    const other = runtime.add("read");
    clickDisclosure(runtime.target(other));

    assert.match(output(reopened), /click to show more/);
    assert.doesNotMatch(output(reopened), INPUT_LABEL);
    assert.match(output(other), INPUT_LABEL);
});

test("a collapsed tool group keeps its cached lines when another target is hovered, an expanded group does not", (t) => {
    const runtime = fixture(t);
    const addGroup = () => {
        const first = runtime.add("read");
        runtime.add("read", { path: "other.ts" }, undefined, false);
        return runtime.target(first);
    };
    const collapsed = addGroup();
    const expanded = addGroup();
    const hovered = addGroup();
    assert.notEqual(collapsed, expanded);
    const open = hintAt(expanded, /click to show more/);
    mouse(expanded, "click", open.row, open.column);
    assert.match(output(expanded), INPUT_LABEL);
    const collapsedBefore = collapsed.render(120);
    const expandedBefore = expanded.render(120);
    assert.equal(collapsed.render(120), collapsedBefore, "Baseline render is cached");

    const hint = hintAt(hovered, /click to show more/);
    const over = mouse(hovered, "move", hint.row, hint.column);
    const collapsedOver = collapsed.render(120);
    const expandedOver = expanded.render(120);
    const off = mouse(hovered, "move", 1, 1);
    const collapsedOff = collapsed.render(120);
    const expandedOff = expanded.render(120);

    assert.equal(over?.render, true);
    assert.equal(off?.render, true);
    assert.equal(collapsedOver, collapsedBefore);
    assert.equal(collapsedOff, collapsedBefore);
    assert.notEqual(expandedOver, expandedBefore);
    assert.notEqual(expandedOff, expandedOver);
});

test("a collapsed group still re-renders when its own hint is hovered", (t) => {
    const runtime = fixture(t);
    runtime.add("read");
    runtime.add("read", { path: "other.ts" }, undefined, false);
    const group = runtime.target(runtime.chat.children.at(-1)!);
    const before = group.render(120);
    const hint = hintAt(group, /click to show more/);

    mouse(group, "move", hint.row, hint.column);
    const actual = group.render(120);

    assert.notEqual(actual, before);
    assert.notDeepEqual(actual, before);
});

function writeDetails(previousContent: string, fileExistedBeforeWrite: boolean) {
    return { luneThemeWrite: { previousContent, fileExistedBeforeWrite } };
}

test("write diff stats refresh when a reused details object or its arguments change", (t) => {
    const { theme } = fixture(t);
    const summary = (content: string, details: object) =>
        stripVTControlCharacters(richDiffSummary(theme, "write", { content }, details));
    const details = writeDetails("a\nb\nc\n", true);

    const first = summary("a\nb\nc\nd\n", details);
    const repeated = summary("a\nb\nc\nd\n", details);
    const otherContent = summary("a\nc\n", details);
    details.luneThemeWrite.previousContent = "a\nb\n";
    const otherPrevious = summary("a\nc\n", details);
    details.luneThemeWrite.fileExistedBeforeWrite = false;
    const created = summary("a\nc\n", details);

    assert.equal(first, "+1 -0");
    assert.equal(repeated, first);
    assert.equal(otherContent, "+0 -1");
    assert.equal(otherPrevious, "+1 -1");
    assert.equal(created, "new file · +2 -0");
});

test("write diff stats in a group row follow in-place changes to the reused details", (t) => {
    const runtime = fixture(t);
    const details = writeDetails("a\nb\n", true);
    const args = { path: "w.ts", content: "a\nb\nc\n" };
    const card = runtime.add("write", args, { content: [{ type: "text", text: "ok" }], details });
    runtime.add("read", { path: "other.ts" }, undefined, false);
    const group = runtime.target(card);
    assert.match(output(group), /\+1 -0/);

    // Streaming publishes a fresh result wrapper around the same mutated details object.
    details.luneThemeWrite.previousContent = "a\nb\nc\nd\n";
    card.updateResult({ content: [{ type: "text", text: "ok" }], details, isError: false }, false);
    const rows = output(group);

    assert.match(rows, /\+0 -1/);
});
