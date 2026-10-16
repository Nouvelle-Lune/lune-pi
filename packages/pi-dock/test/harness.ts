import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext as NodeTestContext } from "node:test";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
    CustomEditor,
    SessionManager,
    type ContextUsage,
    type ExtensionContext,
    type ReadonlyFooterDataProvider,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { LuneDockSnapshot } from "@lune_99/pi-lune-extensions-core/dock";
import { createDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";
import { DockController, type DockControllerSettings } from "../src/dock-controller.ts";
import type { DockLayout } from "../src/dock-footer.ts";
import { DockStatusSource, type DockStatus, type DockUsage } from "../src/dock-status.ts";

type InputHandler = (data: string) => { consume: true } | undefined;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type DisposableComponent = Component & { dispose?: () => void };
type FooterFactory = (
    tui: TUI,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
) => DisposableComponent;

export const identityTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    style: (text: string) => text,
} as unknown as Theme;

/** Records every colour request, so a test can observe which colour the dock chose for a text. */
export function createRecordingTheme(): {
    theme: Theme;
    colorsOf(text: string): string[];
} {
    const requests: { color: string; text: string }[] = [];
    const theme = {
        fg: (color: string, text: string) => {
            requests.push({ color, text });
            return text;
        },
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        style: (text: string) => text,
    } as unknown as Theme;
    return {
        theme,
        colorsOf: (text) => requests.filter((request) => request.text === text).map((r) => r.color),
    };
}

/** Raw terminal input for every key the dock handles, plus Kitty-protocol release events. */
export const keys = {
    down: "\x1b[B",
    up: "\x1b[A",
    left: "\x1b[D",
    right: "\x1b[C",
    home: "\x1b[H",
    end: "\x1b[F",
    superDown: "\x1b[1;9B",
    enter: "\r",
    escape: "\x1b",
    backspace: "\x7f",
    ctrlZ: "\x1a",
    paste: (text: string) => `\x1b[200~${text}\x1b[201~`,
    /** Event type 3 in the Kitty keyboard protocol; a release must never act as a key press. */
    release: {
        down: "\x1b[1;1:3B",
        left: "\x1b[1;1:3D",
        printable: "\x1b[120;1:3u",
    },
};

/** A protocol level that publishes text truncated to its allocation, as plugins do. */
export function textComponent(text: string): Component {
    return { render: (width) => [truncateToWidth(text, width)], invalidate() {} };
}

export function textSnapshot(text: string): LuneDockSnapshot {
    return { base: textComponent(text) };
}

/** Drains queued microtasks so the dock's own refresh and focus-restoration work has run. */
export async function settle(): Promise<void> {
    for (let tick = 0; tick < 8; tick++)
        await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** Polls microtasks until the condition holds; fails instead of hanging when it never does. */
export async function waitFor(condition: () => boolean, description: string): Promise<void> {
    for (let tick = 0; tick < 100; tick++) {
        if (condition()) return;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    assert.fail(`the dock never ${description}`);
}

/** For conditions that depend on file I/O, which microtask polling cannot outlast; bounded, never a fixed sleep. */
export async function waitForIo(
    condition: () => boolean,
    description: string,
    timeoutMs = 3000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) assert.fail(`the dock never ${description}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
}

export class FakeTui {
    focusedComponent: Component | null;
    overlay = false;
    renderRequests = 0;
    readonly focusChanges: (Component | null)[] = [];

    constructor(focused: Component) {
        this.focusedComponent = focused;
    }

    getFocusedComponent(): Component | null {
        return this.focusedComponent;
    }

    setFocus(component: Component | null): void {
        const previous = this.focusedComponent as (Component & { focused?: boolean }) | null;
        if (previous && typeof previous.focused === "boolean") previous.focused = false;
        this.focusedComponent = component;
        const next = component as (Component & { focused?: boolean }) | null;
        if (next && typeof next.focused === "boolean") next.focused = true;
        this.focusChanges.push(component);
    }

    hasOverlay(): boolean {
        return this.overlay;
    }

    requestRender(): void {
        this.renderRequests++;
    }
}

/** The slice of Pi's footer data provider the dock reads; tests change it between frames. */
export class FakeFooterData implements ReadonlyFooterDataProvider {
    branch: string | null = "main";
    providerCount = 1;
    readonly statuses = new Map<string, string>();
    private readonly branchListeners = new Set<() => void>();

    get branchSubscriptions(): number {
        return this.branchListeners.size;
    }

    getGitBranch(): string | null {
        return this.branch;
    }

    getAvailableProviderCount(): number {
        return this.providerCount;
    }

    getExtensionStatuses(): ReadonlyMap<string, string> {
        return this.statuses;
    }

    onBranchChange(callback: () => void): () => void {
        this.branchListeners.add(callback);
        return () => void this.branchListeners.delete(callback);
    }

    fireBranchChange(): void {
        for (const listener of [...this.branchListeners]) listener();
    }
}

export class FakeDockUi {
    tui: FakeTui;
    readonly footerData = new FakeFooterData();
    readonly footerCalls: (FooterFactory | undefined)[] = [];
    footer: DisposableComponent | undefined;
    readonly widgetCalls: { key: string; content: unknown; placement?: string }[] = [];
    readonly notifications: { message: string; type?: string }[] = [];
    editorText = "";
    inputHandler: InputHandler | undefined;
    component: Component | undefined;
    inputUnsubscribed = false;

    constructor(editor: Component) {
        this.tui = new FakeTui(editor);
    }

    setWidget(key: string, content: unknown, options?: { placement?: string }): void {
        this.widgetCalls.push({ key, content, placement: options?.placement });
        const previous = this.component as (Component & { dispose?: () => void }) | undefined;
        previous?.dispose?.();
        if (typeof content === "function") {
            this.component = (content as WidgetFactory)(this.tui as unknown as TUI, identityTheme);
        } else if (content === undefined) {
            this.component = undefined;
        }
    }

    /** Mirrors Pi's setExtensionFooter: the previous footer is disposed before its replacement exists. */
    setFooter(factory: FooterFactory | undefined): void {
        this.footerCalls.push(factory);
        this.footer?.dispose?.();
        this.footer = factory?.(this.tui as unknown as TUI, identityTheme, this.footerData);
    }

    onTerminalInput(handler: InputHandler): () => void {
        this.inputHandler = handler;
        return () => {
            if (this.inputHandler === handler) this.inputHandler = undefined;
            this.inputUnsubscribed = true;
        };
    }

    getEditorText(): string {
        return this.editorText;
    }

    notify(message: string, type?: string): void {
        this.notifications.push({ message, type });
    }

    sendInput(data: string): { consume: true } | undefined {
        return this.inputHandler?.(data);
    }

    replaceTui(tui: FakeTui): void {
        this.tui = tui;
    }
}

interface TestContext {
    ctx: ExtensionContext;
    ui: FakeDockUi;
    editor: CustomEditor;
    controller: DockController;
    registry: ReturnType<typeof createDockRegistry>;
    session: SessionFixture;
    compaction: CompactionReader;
}

export function createMainEditor(
    options: {
        autocomplete?: boolean;
        receivedInput?: string[];
    } = {},
): CustomEditor {
    // The host only needs the public editor type and these two observable methods for its entry gate.
    const editor = Object.create(CustomEditor.prototype) as CustomEditor;
    editor.focused = true;
    editor.isShowingAutocomplete = () => options.autocomplete ?? false;
    editor.handleInput = (data: string) => options.receivedInput?.push(data);
    return editor;
}

export function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
        provider: "anthropic",
        id: "claude-test",
        reasoning: true,
        contextWindow: 200_000,
        ...overrides,
    } as Model<Api>;
}

/** What Pi reports about the running session; a test changes it between frames. */
export interface SessionFixture {
    sessionManager: SessionManager;
    model: Model<Api> | undefined;
    thinkingLevel: ExtensionContext["thinkingLevel"];
    contextUsage: ContextUsage | undefined;
}

/** The fields the status source reads from Pi's context, backed by a real in-memory session. */
export function createSessionContext(options: { ui?: unknown; cwd?: string } = {}): {
    ctx: ExtensionContext;
    session: SessionFixture;
} {
    const cwd = options.cwd ?? "/work/project";
    const session: SessionFixture = {
        sessionManager: SessionManager.inMemory(cwd),
        model: createModel(),
        thinkingLevel: "medium",
        contextUsage: { tokens: 0, contextWindow: 200_000, percent: 0 },
    };
    const ctx = {
        mode: "tui",
        hasUI: true,
        ui: options.ui ?? {},
        cwd,
        sessionManager: session.sessionManager,
        get model() {
            return session.model;
        },
        get thinkingLevel() {
            return session.thinkingLevel;
        },
        getContextUsage: () => session.contextUsage,
        isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    return { ctx, session };
}

export interface CompactionReader {
    enabled: boolean;
    readonly calls: ExtensionContext[];
    read(ctx: ExtensionContext): boolean;
}

/** Stands in for Pi's settings files, which a test must never read. */
export function createCompactionReader(enabled = false): CompactionReader {
    const reader: CompactionReader = {
        enabled,
        calls: [],
        read: (ctx) => {
            reader.calls.push(ctx);
            return reader.enabled;
        },
    };
    return reader;
}

export function createLayout(overrides: Partial<DockLayout> = {}): DockLayout {
    return { style: "ruled", showModel: true, showWorkspace: true, showUsage: true, ...overrides };
}

export function createControllerSettings(
    overrides: Partial<DockControllerSettings> = {},
): DockControllerSettings {
    return { displayMode: "detail", hidden: [], order: {}, ...createLayout(), ...overrides };
}

export function createTestContext(
    options: {
        autocomplete?: boolean;
        receivedInput?: string[];
        /** Applied before the dock attaches, as the extension does on session start. */
        settings?: Partial<DockControllerSettings>;
    } = {},
): TestContext {
    const editor = createMainEditor(options);
    const ui = new FakeDockUi(editor);
    const { ctx, session } = createSessionContext({ ui });
    const registry = createDockRegistry();
    const compaction = createCompactionReader();
    const controller = new DockController(registry, new DockStatusSource(compaction.read));
    if (options.settings) controller.configure(createControllerSettings(options.settings));
    controller.attach(ctx);

    return { ctx, ui, editor, controller, registry, session, compaction };
}

export function createUsage(parts: Partial<Omit<Usage, "cost">> & { cost?: number } = {}): Usage {
    const { cost = 0, ...tokens } = parts;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens };
    return {
        ...usage,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

export function assistantMessage(usage: Usage): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-test",
        usage,
        stopReason: "stop",
        timestamp: 0,
    } as AssistantMessage;
}

export function toolResultMessage(usage?: Usage): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "shell",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
        ...(usage && { usage }),
    } as ToolResultMessage;
}

/** Context usage whose used tokens agree with the share, so a test states only the share and window. */
export function createContext(percent: number | null, window: number): DockStatus["context"] {
    return {
        tokens: percent === null ? null : Math.round((percent / 100) * window),
        percent,
        window,
    };
}

/** A complete status with a quiet default so each test states only the field it is about. */
export function createStatus(
    overrides: Partial<Omit<DockStatus, "usage">> & { usage?: Partial<DockUsage> } = {},
): DockStatus {
    const { usage, ...rest } = overrides;
    return {
        cwd: "/work/project",
        branch: "main",
        sessionName: undefined,
        model: { provider: "anthropic", id: "claude-test", thinking: "high" },
        showProvider: false,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            cacheHitRate: undefined,
            ...usage,
        },
        context: { tokens: 24_600, percent: 12.3, window: 200_000 },
        autoCompact: false,
        extensionStatuses: [],
        ...rest,
    };
}

type SettingsScope = "global" | "project";

/**
 * An isolated Pi agent directory and project. Core resolves its global settings file from
 * PI_CODING_AGENT_DIR, so pointing it at a temporary directory keeps every test off ~/.pi.
 */
export async function createAgentFixture(t: NodeTestContext) {
    const root = await mkdtemp(join(tmpdir(), "pi-dock-test-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    t.after(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    });

    const settingsPath = (scope: SettingsScope) =>
        scope === "global"
            ? join(agentDir, "lune-settings", "pi-dock.json")
            : join(cwd, ".pi", "lune-settings", "pi-dock.json");

    const writeRaw = async (path: string, contents: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, "utf-8");
    };

    return {
        root,
        agentDir,
        cwd,
        settingsPath,
        writeRaw,
        writeScope: (scope: SettingsScope, value: unknown) =>
            writeRaw(settingsPath(scope), JSON.stringify(value)),
        readRaw: (path: string) => readFile(path, "utf-8"),
        /** The dock's stored overrides in one scope; `undefined` when the file is absent. */
        readNamespace: async (scope: SettingsScope) => {
            try {
                return JSON.parse(await readFile(settingsPath(scope), "utf-8")) as Record<
                    string,
                    unknown
                >;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        },
        exists: (path: string) =>
            readFile(path).then(
                () => true,
                () => false,
            ),
    };
}
