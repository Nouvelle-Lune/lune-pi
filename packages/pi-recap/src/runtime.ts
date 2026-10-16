import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
    AgentActivityOutcome,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { observeTerminalFocus, type TerminalInputSource } from "./focus.ts";
import { collectRecapInput, fingerprintRecapInput, type RecapInput } from "./input.ts";
import { generateRecap } from "./generate.ts";
import { resolveRecapModel, type RecapSettingsView } from "./settings.ts";

const entryType = "pi-recap.v1";
const delay = 180_000;

// A round counts as substantial work with this many tool results or this much
// time from the prompt to the final reply.
const minTools = 5;
const minDuration = 60_000;

type Round = {
    completed: boolean;
    startedAt: number;
    endedAt: number;
    tools: number;
};

type RecordData = {
    key: string;
    text?: string;
    // Historical display metadata, not the current widget's mounted state.
    displayed?: boolean;
    failed?: boolean;

    // Optional for compatibility with records written by older versions.
    fingerprint?: string;
    settledAt?: number;
};

type CapturedInput = {
    input: RecapInput;
    fingerprint: string;
};

export class RecapRuntime {
    private ctx: ExtensionContext;

    // Focus starts unknown so automation never assumes the terminal is away.
    private focus: "in" | "out" | "unknown" = "unknown";

    private timer?: ReturnType<typeof setTimeout>;

    private request?: {
        key: string;
        controller: AbortController;
        promise: Promise<void>;
    };

    // Every invalidation advances the generation so late request results are discarded.
    private generation = 0;
    private disposed = false;

    private prompts = 0;
    private settledAt = 0;
    private outcome?: AgentActivityOutcome;
    private running = false;

    private pendingDisplay?: string;

    // Widget visibility belongs to this runtime, never to persisted session data.
    private displayedKey?: string;

    // Runtime-observed outcomes are authoritative when the persisted transcript
    // cannot distinguish an aborted round from a clean completion.
    private readonly outcomes = new Map<string, boolean>();

    // Records are keyed by the exact recap request identity.
    private readonly records = new Map<string, RecordData>();

    private readonly releases: (() => void)[] = [];

    // Used only to detect settings changes that affect runtime scheduling.
    private effectiveSettings: string;

    // Last request usage for diagnostics. Recap usage is not part of session usage.
    diagnostics?: Awaited<ReturnType<typeof generateRecap>>;

    private releaseFocus?: () => void;

    private readonly focusInput: TerminalInputSource;
    private readonly pi: ExtensionAPI;
    private readonly view: RecapSettingsView;

    constructor(
        pi: ExtensionAPI,
        ctx: ExtensionContext,
        view: RecapSettingsView,
        focusInput: TerminalInputSource = process.stdin,
    ) {
        view.signal.throwIfAborted();
        this.pi = pi;
        this.ctx = ctx;
        this.view = view;
        this.focusInput = focusInput;

        this.effectiveSettings = this.settingsKey();

        this.restore();

        this.releases.push(
            view.subscribe(() => {
                const next = this.settingsKey();

                if (next === this.effectiveSettings) {
                    return;
                }

                this.effectiveSettings = next;

                this.invalidate();
                this.bindFocus();
                this.schedule();
            }),
        );

        // Core owns the view; its retirement must also stop Recap's business resources.
        const onRetire = () => this.dispose();
        view.signal.addEventListener("abort", onRetire, { once: true });
        this.releases.push(() => view.signal.removeEventListener("abort", onRetire));

        this.bindFocus();
    }

    private settings() {
        return this.view.snapshot();
    }

    private settingsKey(): string {
        return JSON.stringify(this.settings());
    }

    /**
     * Capture the exact recap input and derive its identity from the same
     * representation that will be sent to the model.
     */
    private captureInput(): CapturedInput {
        const input = collectRecapInput(this.ctx);

        return {
            input,
            fingerprint: fingerprintRecapInput(input),
        };
    }

    /**
     * Focus observation exists only while automatic recap is enabled.
     */
    private bindFocus(): void {
        if (this.ctx.mode === "tui" && this.view.get("enabled") && this.releaseFocus) {
            return;
        }

        this.releaseFocus?.();
        this.releaseFocus = undefined;
        this.focus = "unknown";

        if (this.ctx.mode !== "tui" || !this.view.get("enabled")) {
            return;
        }

        this.releaseFocus = observeTerminalFocus(this.focusInput, (focus) => {
            this.focus = focus;

            if (focus === "in") {
                this.clearTimer();
                this.showCached();
            } else {
                this.schedule();
            }
        });
    }

    /**
     * Manual and automatic entry points share the same runtime safety gate.
     */
    private ready(): boolean {
        return (
            !this.disposed &&
            this.ctx.mode === "tui" &&
            !this.running &&
            this.ctx.isIdle() &&
            !this.ctx.hasPendingMessages() &&
            this.prompts === 0
        );
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = undefined;
    }

    update(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }

    /**
     * Abort in-flight work and remove any hint derived from stale state.
     */
    invalidate(): void {
        this.clearTimer();

        this.generation++;

        this.request?.controller.abort();
        this.request = undefined;

        this.pendingDisplay = undefined;
        this.displayedKey = undefined;

        clearRecap(this.ctx);
    }

    start(ctx: ExtensionContext): void {
        this.update(ctx);
        this.invalidate();

        this.running = true;
        this.outcome = undefined;
    }

    beforeSettle(outcome: AgentActivityOutcome, ctx: ExtensionContext): void {
        this.update(ctx);
        this.outcome = outcome;
    }

    /**
     * A round is considered completed only when this runtime observed a clean
     * settle and the corresponding assistant response stopped normally.
     */
    settled(ctx: ExtensionContext): void {
        this.update(ctx);

        this.running = false;
        this.settledAt = Date.now();

        const branch = ctx.sessionManager.getBranch();

        const user = branch.findLast(
            (entry) => entry.type === "message" && entry.message.role === "user",
        );

        const assistant = branch.findLast(
            (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (user) {
            const completed =
                this.outcome === "completed" &&
                assistant?.type === "message" &&
                assistant.message.role === "assistant" &&
                assistant.message.stopReason === "stop";

            this.outcomes.set(user.id, completed);

            if (this.view.get("enabled")) {
                this.pi.appendEntry(`${entryType}.settled`, {
                    userId: user.id,
                    at: this.settledAt,
                    completed,
                });
            }
        }

        this.schedule();
    }

    input(ctx: ExtensionContext): void {
        this.update(ctx);
        this.invalidate();
    }

    /**
     * Cached records belong to the previous branch view and must be rebuilt
     * from the newly selected branch.
     */
    branchChanged(ctx: ExtensionContext): void {
        this.update(ctx);
        this.invalidate();

        this.records.clear();

        this.restore();
        this.schedule();
    }

    prompt(start: boolean, ctx: ExtensionContext): void {
        this.update(ctx);

        this.prompts = Math.max(0, this.prompts + (start ? 1 : -1));

        if (start) {
            this.clearTimer();
            return;
        }

        this.showCached();
        this.schedule();
    }

    /**
     * Restore persisted recap records and settle markers without re-running a
     * request merely because the process or extension was reloaded.
     */
    private restore(): void {
        this.outcomes.clear();
        this.records.clear();
        this.settledAt = 0;

        const { fingerprint } = this.captureInput();

        const branch = this.ctx.sessionManager.getBranch();

        const lastAssistant = branch.findLast(
            (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (lastAssistant) {
            this.settledAt = Date.parse(lastAssistant.timestamp) || 0;
        }

        for (const entry of branch) {
            if (entry.type !== "custom") {
                continue;
            }

            if (entry.customType === entryType) {
                const data = entry.data as RecordData | undefined;

                if (!data || typeof data.key !== "string") {
                    continue;
                }

                this.records.set(data.key, data);

                if (data.fingerprint === fingerprint && typeof data.settledAt === "number") {
                    this.settledAt = data.settledAt;
                }

                continue;
            }

            if (entry.customType === `${entryType}.settled`) {
                const data = entry.data as { at?: number } | undefined;

                if (typeof data?.at === "number") {
                    this.settledAt = data.at;
                }
            }
        }
    }

    /**
     * Automatic recap is worth a model request only after a cleanly completed
     * round that did real work, measured on the latest such round because that
     * is the work the returning user has not seen.
     *
     * Runtime-observed outcomes win because persisted assistant messages alone
     * cannot always distinguish interrupted work from a completed round.
     */
    private hasSubstantialRound(): boolean {
        const rounds = new Map<string, Round>();
        let current: Round | undefined;

        for (const entry of this.ctx.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "user") {
                const startedAt = Date.parse(entry.timestamp);

                current = { completed: false, startedAt, endedAt: startedAt, tools: 0 };
                rounds.set(entry.id, current);

                continue;
            }

            if (entry.type === "message" && current) {
                if (entry.message.role === "toolResult") {
                    current.tools++;
                } else if (entry.message.role === "assistant") {
                    current.completed = entry.message.stopReason === "stop";
                    current.endedAt = Date.parse(entry.timestamp);
                }

                continue;
            }

            if (entry.type === "custom" && entry.customType === `${entryType}.settled`) {
                const data = entry.data as
                    | {
                          userId?: string;
                          completed?: boolean;
                      }
                    | undefined;

                if (typeof data?.userId === "string") {
                    const round = rounds.get(data.userId);

                    if (round) {
                        round.completed = data.completed === true;
                    }
                }
            }
        }

        for (const [id, completed] of this.outcomes) {
            const round = rounds.get(id);

            if (round) {
                round.completed = completed;
            }
        }

        const latest = [...rounds.values()].findLast((round) => round.completed);

        // An unparsable timestamp yields NaN, which fails the duration test.
        return (
            latest !== undefined &&
            (latest.tools >= minTools || latest.endedAt - latest.startedAt >= minDuration)
        );
    }

    /**
     * Build the identity of one model request.
     *
     * Only request-affecting state belongs in the cache key. Runtime scheduling
     * state such as enabled/disabled or settledAt must not force regeneration.
     */
    private snapshot(captured = this.captureInput()) {
        const settings = this.settings();
        const model = resolveRecapModel(this.ctx, settings);

        if (!model) {
            throw new Error(
                settings.model
                    ? `Recap model ${settings.model.provider}/${settings.model.id} is not registered`
                    : "Select a session or recap model first",
            );
        }

        const thinking = clampThinkingLevel(model, settings.thinkingLevel);

        const key = JSON.stringify([
            this.ctx.sessionManager.getSessionId(),
            captured.fingerprint,
            model.provider,
            model.id,
            thinking,
        ]);

        return {
            ...captured,
            model,
            thinking,
            key,
        };
    }

    /**
     * Failed model resolution also needs a stable identity so automatic
     * retries wait for meaningful state to change.
     */
    private unresolvedKey(captured: CapturedInput): string {
        const settings = this.settings();

        return JSON.stringify([
            "unresolved",
            this.ctx.sessionManager.getSessionId(),
            captured.fingerprint,
            settings.model,
            settings.thinkingLevel,
            this.ctx.model?.provider,
            this.ctx.model?.id,
        ]);
    }

    /**
     * Persistence receives a complete record. It never re-reads session input,
     * because doing so could associate a result with a newer snapshot.
     */
    private remember(data: RecordData): void {
        const record: RecordData = {
            ...data,
            settledAt: this.settledAt,
        };

        this.records.set(record.key, record);
        this.pi.appendEntry(entryType, record);
    }

    /**
     * If the terminal is temporarily busy, retain the record key and display
     * the same cached result once the runtime becomes ready.
     */
    private display(data: RecordData): void {
        if (!data.text) {
            return;
        }

        if (!this.ready()) {
            this.pendingDisplay = data.key;
            return;
        }

        this.pendingDisplay = undefined;

        showRecap(this.ctx, data.text);
        this.displayedKey = data.key;

        this.remember({
            ...data,
            displayed: true,
        });
    }

    private showCached(): void {
        if (!this.ready() || (!this.view.get("enabled") && !this.pendingDisplay)) {
            return;
        }

        try {
            const data = this.records.get(this.snapshot().key);

            if (
                data?.text &&
                (data.key !== this.displayedKey || data.key === this.pendingDisplay)
            ) {
                this.display(data);
            }
        } catch {
            // Resolution errors are reported by explicit request attempts.
        }
    }

    private schedule(): void {
        this.clearTimer();

        if (
            !this.ready() ||
            !this.view.get("enabled") ||
            this.focus !== "out" ||
            !this.settledAt ||
            !this.hasSubstantialRound() ||
            this.request
        ) {
            return;
        }

        const wait = Math.max(0, this.settledAt + delay - Date.now());

        if (wait === 0) {
            void this.run(false);
            return;
        }

        // Timers use a monotonic clock while the delay is measured against the
        // wall clock, so a timer can fire a millisecond early or after a clock
        // adjustment. Re-evaluating keeps that from silently dropping the recap.
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.schedule();
        }, wait);

        // Automatic recap must never keep the process alive.
        this.timer.unref?.();
    }

    /**
     * Manual recap skips focus, delay, and completed-round thresholds while
     * retaining the same idle and prompt-safety conditions.
     */
    async manual(ctx: ExtensionContext): Promise<void> {
        this.update(ctx);

        if (ctx.mode !== "tui") {
            ctx.ui.notify("Recap requires an interactive terminal", "warning");

            return;
        }

        if (!this.ready()) {
            ctx.ui.notify(
                "Run /recap after the current task and pending prompts have finished",
                "warning",
            );

            return;
        }

        await this.run(true);
    }

    private async run(manual: boolean): Promise<void> {
        if (!this.ready()) {
            return;
        }

        if (
            !manual &&
            (!this.view.get("enabled") ||
                this.focus !== "out" ||
                !this.hasSubstantialRound() ||
                Date.now() < this.settledAt + delay)
        ) {
            return;
        }

        const captured = this.captureInput();

        if (!captured.input.hasContent) {
            if (manual) {
                this.ctx.ui.notify("No conversation content to recap yet", "info");
            }

            return;
        }

        let snapshot: ReturnType<RecapRuntime["snapshot"]>;

        try {
            snapshot = this.snapshot(captured);
        } catch (error) {
            const key = this.unresolvedKey(captured);

            // Automatic retries wait for the unresolved request identity to
            // change; manual recap always permits an explicit retry.
            if (!manual && this.records.get(key)?.failed) {
                return;
            }

            this.remember({
                key,
                failed: true,
                fingerprint: captured.fingerprint,
            });

            this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");

            return;
        }

        const previous = this.records.get(snapshot.key);

        if (previous?.text) {
            if (manual) {
                this.display(previous);
            }

            return;
        }

        if (!manual && previous?.failed) {
            return;
        }

        if (this.request?.key === snapshot.key) {
            await this.request.promise;

            const cached = this.records.get(snapshot.key);

            if (manual && cached?.text && cached.key !== this.displayedKey) {
                this.display(cached);
            }

            return;
        }

        this.clearTimer();

        const generation = this.generation;
        const ctx = this.ctx;
        const controller = new AbortController();

        const signal = ctx.signal
            ? AbortSignal.any([ctx.signal, controller.signal])
            : controller.signal;

        const request = {
            key: snapshot.key,
            controller,
            promise: Promise.resolve(),
        };

        this.request = request;

        /**
         * A completed provider request may still be stale if the branch,
         * settings, model selection, or projected conversation changed while
         * it was running.
         */
        const valid = (): boolean => {
            if (this.disposed || generation !== this.generation || signal.aborted) {
                return false;
            }

            try {
                return this.snapshot().key === snapshot.key;
            } catch {
                return false;
            }
        };

        request.promise = (async () => {
            try {
                const result = await generateRecap(
                    ctx,
                    snapshot.input,
                    snapshot.model,
                    snapshot.thinking,
                    signal,
                );

                if (!valid()) {
                    return;
                }

                this.diagnostics = result;

                const data: RecordData = {
                    key: snapshot.key,
                    text: result.text,
                    fingerprint: snapshot.fingerprint,
                };

                this.remember(data);

                if (manual || this.focus === "in") {
                    this.display(data);
                }
            } catch (error) {
                if (!valid() || (error instanceof Error && error.name === "AbortError")) {
                    return;
                }

                this.remember({
                    key: snapshot.key,
                    failed: true,
                    fingerprint: snapshot.fingerprint,
                });

                ctx.ui.notify(
                    `Recap failed: ${error instanceof Error ? error.message : String(error)}`,
                    "warning",
                );
            } finally {
                if (this.request === request) {
                    this.request = undefined;
                }
            }
        })();

        await request.promise;
    }

    /**
     * Shutdown and session reload may both dispose the same runtime.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.invalidate();

        this.releaseFocus?.();
        this.releaseFocus = undefined;

        for (const release of this.releases) {
            release();
        }

        this.records.clear();
    }
}

/**
 * A widget can be removed when the next round starts; notify() would leave
 * stale recap text in the terminal history.
 */
export function showRecap(ctx: ExtensionContext, text: string): void {
    ctx.ui.setWidget("pi-recap", (_tui, theme) => ({
        render: (width) =>
            wrapTextWithAnsi(`☾ recap · ${text}`, width).map((line) => theme.fg("dim", line)),
        invalidate() {},
    }));
}

export function clearRecap(ctx: ExtensionContext): void {
    if (ctx.mode === "tui") {
        ctx.ui.setWidget("pi-recap", undefined);
    }
}
