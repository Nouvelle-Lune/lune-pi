import { SESSION_TEXT_LIMIT } from "./budget.ts";
import { ExternalSessions } from "./external.ts";
import { PiSessions } from "./pi.ts";
import { INDEX_BUDGET_BYTES, SessionIndex, sessionIndexFile } from "./session-index.ts";
import type { LocalSession } from "./session.ts";

/** A list older than this is reloaded in the background on the next lookup. */
const REFRESH_AFTER_MS = 60_000;

/**
 * The newest local Pi, Codex and Claude Code main sessions that fit the index budget, newest
 * activity first. Each load asks for the budget again, so a changed setting applies to the
 * next load.
 *
 * Every load checks each session file and reads only those that changed since the saved
 * index. Lookups serve the cached list and reload it in the background. The owner disposes
 * the catalog on session shutdown; a load that finishes later is discarded.
 */
export class SessionCatalog {
    private readonly onBackgroundError: (error: unknown) => void;
    private readonly budget: () => Promise<number>;
    private readonly textLimit: () => Promise<number>;
    private readonly abort = new AbortController();
    private readonly index = new SessionIndex(sessionIndexFile());
    private readonly pi: PiSessions;
    private readonly external = new ExternalSessions();
    private sessions: readonly LocalSession[] = [];
    private loaded = false;
    private loadedAt = 0;
    private loading: Promise<readonly LocalSession[]> | undefined;

    /** `budget` gives the bytes the session index may keep. */
    constructor(
        sessionDir: string,
        onBackgroundError: (error: unknown) => void,
        budget: () => Promise<number> = async () => INDEX_BUDGET_BYTES,
        textLimit: () => Promise<number> = async () => SESSION_TEXT_LIMIT,
    ) {
        this.pi = new PiSessions(sessionDir);
        this.onBackgroundError = onBackgroundError;
        this.budget = budget;
        this.textLimit = textLimit;
    }

    /** The cached list, empty before the first load. A stale list starts a background reload. */
    snapshot(): readonly LocalSession[] {
        if (Date.now() - this.loadedAt > REFRESH_AFTER_MS) this.refreshInBackground();
        return this.sessions;
    }

    /** Waits only for the first load; later lookups return the cached list at once. */
    async list(): Promise<readonly LocalSession[]> {
        return this.loaded ? this.snapshot() : this.reload();
    }

    /**
     * Settles when the first load does or when `signal` aborts. Whoever started the load
     * handles its failure, so a waiting caller only reads snapshot() again.
     *
     * A failed first load is retried here. snapshot() only retries a stale list, and `@@`
     * would otherwise stay empty for a minute after a transient read error.
     */
    async whenLoaded(signal: AbortSignal): Promise<void> {
        if (this.loaded) return;
        this.refreshInBackground();
        const loading = this.loading;
        if (!loading || signal.aborted) return;
        await new Promise<void>((resolve) => {
            const settle = () => {
                signal.removeEventListener("abort", settle);
                resolve();
            };
            signal.addEventListener("abort", settle, { once: true });
            loading.then(settle, settle);
        });
    }

    /** Concurrent callers share one load. */
    reload(): Promise<readonly LocalSession[]> {
        this.loadedAt = Date.now();
        this.loading ??= this.load().finally(() => {
            this.loading = undefined;
        });
        return this.loading;
    }

    dispose(): void {
        this.abort.abort();
        this.external.clear();
    }

    private async load(): Promise<readonly LocalSession[]> {
        const signal = this.abort.signal;
        // A failed index only costs a full read; the scan below writes a new one.
        await this.index.load(signal).catch((error: unknown) => this.report(error));
        // Settings that cannot be read are reported where they are edited; the session list
        // keeps working with the default size instead.
        this.index.budget = await this.budget().catch(() => INDEX_BUDGET_BYTES);
        this.index.textLimit = await this.textLimit().catch(() => SESSION_TEXT_LIMIT);
        const [pi, external] = await Promise.all([
            this.pi.list(signal),
            this.external.list(signal, this.onBackgroundError),
        ]);
        // Pi first, so sessions with equal activity times keep listAll's order.
        const { sessions: listed, errors } = await this.index.scan([...pi, ...external], signal);
        signal.throwIfAborted();
        if (errors.length > 0) {
            this.report(
                new AggregateError(errors, errors.map((error) => error.message).join("\n")),
            );
        }
        await this.index.save().catch((error: unknown) => this.report(error));
        signal.throwIfAborted();
        const sessions = listed.sort(
            (left, right) => right.modified.getTime() - left.modified.getTime(),
        );
        this.sessions = sessions;
        this.loaded = true;
        return sessions;
    }

    private refreshInBackground(): void {
        if (this.loading || this.abort.signal.aborted) return;
        this.reload().catch((error: unknown) => {
            if (!this.abort.signal.aborted) this.onBackgroundError(error);
        });
    }

    private report(error: unknown): void {
        this.abort.signal.throwIfAborted();
        this.onBackgroundError(error);
    }
}
