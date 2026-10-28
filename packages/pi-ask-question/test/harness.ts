/**
 * Shared test harness for pi-ask-question.
 *
 * The extension talks to two pi surfaces the tests have to stand in for:
 * - `pi` through tools, commands, lifecycle events, session entries and messages; and
 * - `ctx.ui` through the below-editor widget and the question overlay.
 *
 * The fakes reproduce only the consumed contract: keyed widgets with placement buckets,
 * a `custom()` that instantiates the component eagerly so a test can drive it, session
 * entries appended to a mutable branch array, and `sendMessage` calls recorded as delivery
 * attempts. A call is never a delivery: only `commitSendMessage` models pi having accepted
 * the message into the session. The real TUI is not simulated.
 */
import assert from "node:assert/strict";

import type {
    ExtensionAPI,
    ExtensionContext,
    MessageRenderer,
    Theme,
    WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

import type { QuestionManager } from "../src/core/questionManager.ts";
import { installAskQuestion } from "../src/index.ts";

/** What `setWidget` accepts here: text lines or a component factory (the docks pass the latter). */
export type WidgetContent = string[] | ((tui: TUI, theme: Theme) => Component);

/**
 * A standalone dock row without the one-column left margin it renders with.
 *
 * pi pads string widgets by one column on each side; the dock keeps that margin when it draws as a
 * component, so a row that lacks it is a regression.
 */
export function withoutMargin(line: string): string {
    assert.ok(
        line.startsWith(" "),
        `the dock row must start with a 1-space margin: ${JSON.stringify(line)}`,
    );
    return line.slice(1);
}

/**
 * The single standalone dock row of `key` rendered at `width`, without its margin; `undefined`
 * when nothing is mounted.
 */
export function dockRow(
    ui: FakeUi,
    key = "pi-ask-question",
    width = DEFAULT_WIDGET_WIDTH,
): string | undefined {
    const lines = ui.renderedWidget("belowEditor", key, width);

    if (lines === undefined) {
        return undefined;
    }

    assert.equal(lines.length, 1, "the dock must stay a single line");

    return withoutMargin(lines[0]!);
}

/** Width at which `renderedWidget` renders a component-factory widget unless a test picks another. */
export const DEFAULT_WIDGET_WIDTH = 120;

export interface WidgetCall {
    key: string;
    content: WidgetContent | undefined;
    placement: WidgetPlacement | undefined;
}

export interface NotifyCall {
    message: string;
    type: string | undefined;
}

export interface SendMessageCall {
    message: {
        customType: string;
        content: unknown;
        display: boolean;
        details: unknown;
    };
    options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

/** A custom message pi has accepted; what the session branch actually holds. */
export interface CommittedMessage {
    customType: string;
    content: unknown;
    display: boolean;
    details: unknown;
}

export interface AppendEntryCall {
    customType: string;
    data: unknown;
}

export interface CustomCall {
    overlay: boolean | undefined;
    /** Resolves this overlay's `custom()` promise, as pi does when the interaction closes. */
    close: (result?: unknown) => void;
}

/** Extension state written through `appendEntry`; does not enter the model context. */
export interface FakeCustomEntry {
    type: "custom";
    customType: string;
    data?: unknown;
}

/** A message pi accepted into the session as a `custom_message` entry. */
export interface FakeCommittedMessageEntry {
    type: "custom_message";
    customType: string;
    content: unknown;
    display: boolean;
    details?: unknown;
}

/** One entry of the fake session branch; `restore` and reconciliation read these. */
export type FakeBranchEntry = FakeCustomEntry | FakeCommittedMessageEntry;

export interface FakeUi {
    readonly notifyCalls: NotifyCall[];
    readonly widgetCalls: WidgetCall[];
    readonly customCalls: CustomCall[];
    readonly theme: Theme;
    /** Component returned by the latest `custom()` factory, for driving input. */
    readonly panel: Component | undefined;
    /** Resolves when the latest `custom()` interaction closes. */
    readonly panelClosed: Promise<void> | undefined;
    notify(message: string, type?: string): void;
    setWidget(
        key: string,
        content: WidgetContent | undefined,
        options?: { placement?: WidgetPlacement },
    ): void;
    custom<T>(
        factory: (
            tui: TUI,
            theme: Theme,
            keybindings: KeybindingsManager,
            done: (result: T) => void,
        ) => Component & { dispose?(): void },
        options?: { overlay?: boolean },
    ): Promise<T>;
    /** Content currently mounted for `key`, or `undefined` when the key is not mounted. */
    mountedWidget(placement: WidgetPlacement, key: string): WidgetContent | undefined;
    /** Lines mounted for `key`; a component factory is rendered at `width`, as pi would. */
    renderedWidget(placement: WidgetPlacement, key: string, width?: number): string[] | undefined;
    mountedKeys(placement: WidgetPlacement): readonly string[];
}

export function createFakeTui(rows = 40, cols = 120): TUI {
    return {
        requestRender: () => undefined,
        terminal: { rows, cols },
    } as unknown as TUI;
}

export function createFakeTheme(): Theme {
    const identity = (text: string) => text;

    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: identity,
        style: identity,
        colors: {},
    } as unknown as Theme;
}

export function createFakeKeybindings(): KeybindingsManager {
    return { matches: () => false } as unknown as KeybindingsManager;
}

export function createFakeUi(): FakeUi {
    const buckets: Record<WidgetPlacement, Map<string, WidgetContent>> = {
        aboveEditor: new Map(),
        belowEditor: new Map(),
    };

    const notifyCalls: NotifyCall[] = [];
    const widgetCalls: WidgetCall[] = [];
    const customCalls: CustomCall[] = [];

    let panel: Component | undefined;
    let panelClosed: Promise<void> | undefined;

    const ui: FakeUi = {
        notifyCalls,
        widgetCalls,
        customCalls,
        theme: createFakeTheme(),

        get panel() {
            return panel;
        },

        get panelClosed() {
            return panelClosed;
        },

        notify(message, type) {
            notifyCalls.push({ message, type });
        },

        setWidget(key, content, options) {
            const placement = options?.placement ?? "aboveEditor";
            widgetCalls.push({ key, content, placement: options?.placement });

            // pi removes a key from both buckets before inserting, so a repeat call reorders it.
            buckets.aboveEditor.delete(key);
            buckets.belowEditor.delete(key);

            if (content !== undefined) {
                buckets[placement].set(key, content);
            }
        },

        custom(factory, options) {
            let resolve!: (result: unknown) => void;
            const promise = new Promise<unknown>((res) => {
                resolve = res;
            });

            customCalls.push({ overlay: options?.overlay, close: (result) => resolve(result) });

            panel = factory(createFakeTui(), createFakeTheme(), createFakeKeybindings(), resolve);
            panelClosed = promise.then(() => undefined);

            return promise as Promise<never>;
        },

        mountedWidget(placement, key) {
            return buckets[placement].get(key);
        },

        renderedWidget(placement, key, width = DEFAULT_WIDGET_WIDTH) {
            const content = buckets[placement].get(key);

            if (typeof content !== "function") {
                return content;
            }

            return content(createFakeTui(), ui.theme).render(width);
        },

        mountedKeys(placement) {
            return [...buckets[placement].keys()];
        },
    };

    return ui;
}

export interface FakeContextOptions {
    ui?: FakeUi;
    mode?: string;
    hasUI?: boolean;
    branch?: FakeBranchEntry[];
}

export function createFakeContext(options: FakeContextOptions = {}): ExtensionContext {
    return {
        ui: options.ui ?? createFakeUi(),
        mode: options.mode ?? "tui",
        hasUI: options.hasUI ?? true,
        cwd: "/work",
        sessionManager: {
            getBranch: () => options.branch ?? [],
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal: undefined,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => undefined,
        compact: () => undefined,
        getSystemPrompt: () => "",
    } as unknown as ExtensionContext;
}

export type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface FakePiHost {
    readonly api: ExtensionAPI;
    readonly tools: Map<string, unknown>;
    readonly commands: Map<
        string,
        {
            description?: string;
            handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
        }
    >;
    readonly handlers: Map<string, ExtensionHandler[]>;
    readonly messageRenderers: Map<string, MessageRenderer<unknown>>;
    /** Delivery attempts: the extension asked pi to send these; pi has not accepted them. */
    readonly sendMessageCalls: SendMessageCall[];
    /** Messages pi really holds in the session; only `commitSendMessage` writes here. */
    readonly committedMessages: CommittedMessage[];
    readonly appendEntryCalls: AppendEntryCall[];
    /** Session branch the fake `appendEntry` writes; pass it to `createFakeContext`. */
    readonly branch: FakeBranchEntry[];
    /** Point the fake session at another branch, as a tree jump or a session switch does. */
    activateBranch(branch: FakeBranchEntry[]): void;
    /** Write the message of a recorded attempt into the session, as pi does once accepted. */
    commitSendMessage(index: number): CommittedMessage;
    fire(event: string, ctx: ExtensionContext): Promise<void>;
}

export function createFakePiHost(
    register: (pi: ExtensionAPI) => void,
    options: { branch?: FakeBranchEntry[] } = {},
): FakePiHost {
    const tools = new Map<string, unknown>();
    const commands = new Map<
        string,
        {
            description?: string;
            handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
        }
    >();
    const handlers = new Map<string, ExtensionHandler[]>();
    const messageRenderers = new Map<string, MessageRenderer<unknown>>();
    const sendMessageCalls: SendMessageCall[] = [];
    const committedMessages: CommittedMessage[] = [];
    const appendEntryCalls: AppendEntryCall[] = [];
    let activeBranch = options.branch ?? [];

    const api = {
        on(event: string, handler: ExtensionHandler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);

            return () => {
                const index = list.indexOf(handler);

                if (index >= 0) {
                    list.splice(index, 1);
                }
            };
        },

        registerTool(tool: { name: string }) {
            tools.set(tool.name, tool);
        },

        registerCommand(
            name: string,
            options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
        ) {
            commands.set(name, options);
        },

        registerMessageRenderer(customType: string, renderer: MessageRenderer<unknown>) {
            messageRenderers.set(customType, renderer);
        },

        appendEntry(customType: string, data: unknown) {
            appendEntryCalls.push({ customType, data });
            activeBranch.push({ type: "custom", customType, data });
        },

        // Recording the call is all this does: pi may still drop a steered message before it
        // reaches the session, so acceptance is modeled by `commitSendMessage` instead.
        sendMessage(message: SendMessageCall["message"], options: SendMessageCall["options"]) {
            sendMessageCalls.push({ message, options });
        },

        sendUserMessage() {
            throw new Error("sendUserMessage is not part of this extension");
        },
    } as unknown as ExtensionAPI;

    register(api);

    return {
        api,
        tools,
        commands,
        handlers,
        messageRenderers,
        sendMessageCalls,
        committedMessages,
        appendEntryCalls,

        get branch() {
            return activeBranch;
        },

        activateBranch(branch) {
            activeBranch = branch;
        },

        commitSendMessage(index) {
            const call = sendMessageCalls[index];

            if (!call) {
                throw new Error(`no sendMessage attempt recorded at index ${index}`);
            }

            const committed: CommittedMessage = {
                customType: call.message.customType,
                content: call.message.content,
                display: call.message.display,
                details: call.message.details,
            };

            committedMessages.push(committed);
            activeBranch.push({ type: "custom_message", ...committed });

            return committed;
        },

        async fire(event, ctx) {
            for (const handler of handlers.get(event) ?? []) {
                await handler({ type: event }, ctx);
            }
        },
    };
}

/** A fake host with one load of the extension on it, and the question manager that load owns. */
export type AskQuestionHost = FakePiHost & { readonly manager: QuestionManager };

/**
 * Load the extension once onto a fresh fake host.
 *
 * Every call is an independent load with its own manager and panel ownership, as pi gives each
 * session; two calls in one test stand for two sessions that share a module.
 */
export function loadAskQuestion(options: { branch?: FakeBranchEntry[] } = {}): AskQuestionHost {
    let manager: QuestionManager | undefined;
    const host = createFakePiHost((api) => {
        manager = installAskQuestion(api);
    }, options);

    return Object.assign(host, { manager: manager! });
}

/**
 * Tool definition with opaque schema types, matching the harness' untyped access.
 *
 * `execute` is called directly, so this harness does not run pi's argument validation;
 * `test/unit/tool-schema.test.ts` covers the schema against the real validator.
 */
export interface AnyToolDefinition {
    name: string;
    description: string;
    parameters?: unknown;
    details?: unknown;
    execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((partial: { content: unknown; details: unknown }) => void) | undefined,
        ctx: ExtensionContext,
    ): Promise<{
        content: Array<{ type: string; text?: string }>;
        details: unknown;
        isError?: boolean;
    }>;
    /** Pi calls this with partial arguments while the model still streams the call. */
    renderCall?(args: unknown, theme: Theme, context: unknown): Component;
    renderResult?(
        result: { content: Array<{ type: string; text?: string }>; details: unknown },
        options: unknown,
        theme: Theme,
        context: unknown,
    ): Component;
}

export function requireTool(host: FakePiHost, name: string): AnyToolDefinition {
    const tool = host.tools.get(name);

    if (!tool) {
        throw new Error(`tool not registered: ${name}`);
    }

    return tool as AnyToolDefinition;
}
