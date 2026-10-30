import { ExternalSessions } from "./external.ts";
import { PiSessions } from "./pi.ts";
import { SessionIndex, sessionIndexFile } from "./session-index.ts";
import type { LocalSession } from "./session.ts";

/** A list older than this is reloaded in the background on the next lookup. */
const REFRESH_AFTER_MS = 60_000;

/**
 * Local Pi, Codex and Claude Code main sessions, newest activity first.
 *
 * Every load checks each session file and reads only those that changed since the saved
 * index. Lookups serve the cached list and reload it in the background. The owner disposes
 * the catalog on session shutdown; a load that finishes later is discarded.
 */
export class SessionCatalog {
    private readonly onBackgroundError: (error: unknown) => void;
    private readonly abort = new AbortController();
    private readonly index = new SessionIndex(sessionIndexFile());
    private readonly pi: PiSessions;
    private readonly external = new ExternalSessions(this.index);
    private sessions: readonly LocalSession[] = [];
    private loaded = false;
    private loadedAt = 0;
    private loading: Promise<readonly LocalSession[]> | undefined;

    constructor(sessionDir: string, onBackgroundError: (error: unknown) => void) {
        this.pi = new PiSessions(sessionDir, this.index);
        this.onBackgroundError = onBackgroundError;
    }

    /** The cached list, empty before the first load. A stale list starts a background reload. */
    snapshot(): readonly LocalSession[] {
        const stale = Date.now() - this.loadedAt > REFRESH_AFTER_MS;
        if (stale && !this.loading && !this.abort.signal.aborted) {
            this.reload().catch((error: unknown) => {
                if (!this.abort.signal.aborted) this.onBackgroundError(error);
            });
        }
        return this.sessions;
    }

    /** Waits only for the first load; later lookups return the cached list at once. */
    async list(): Promise<readonly LocalSession[]> {
        return this.loaded ? this.snapshot() : this.reload();
    }

    /**
     * Settles when the first load does or when `signal` aborts. Whoever started the load
     * handles its failure, so a waiting caller only reads snapshot() again.
     */
    async whenLoaded(signal: AbortSignal): Promise<void> {
        if (this.loaded) return;
        this.snapshot();
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
        this.index.beginScan();
        const [pi, external] = await Promise.all([
            this.pi.list(signal, this.onBackgroundError),
            this.external.list(signal, this.onBackgroundError),
        ]);
        signal.throwIfAborted();
        await this.index.endScan().catch((error: unknown) => this.report(error));
        signal.throwIfAborted();
        const sessions = [...pi, ...external].sort(
            (left, right) => right.modified.getTime() - left.modified.getTime(),
        );
        this.sessions = sessions;
        this.loaded = true;
        return sessions;
    }

    private report(error: unknown): void {
        this.abort.signal.throwIfAborted();
        this.onBackgroundError(error);
    }
}
