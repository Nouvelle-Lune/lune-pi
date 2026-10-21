import { dirname, join, resolve } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

/** A list older than this is reloaded in the background on the next lookup. */
const REFRESH_AFTER_MS = 60_000;

/**
 * Every local session, newest activity first, as pi's SessionManager.listAll() returns them.
 *
 * Listing reads every session file (about a second for a few hundred sessions), so lookups
 * serve the cached list and reload it in the background. The owner disposes the catalog on
 * session shutdown; a load that finishes later is discarded.
 */
export class SessionCatalog {
    private readonly sessionDir: string;
    private readonly onBackgroundError: (error: unknown) => void;
    private readonly abort = new AbortController();
    private sessions: readonly SessionInfo[] = [];
    private loaded = false;
    private loadedAt = 0;
    private loading: Promise<readonly SessionInfo[]> | undefined;

    constructor(sessionDir: string, onBackgroundError: (error: unknown) => void) {
        this.sessionDir = sessionDir;
        this.onBackgroundError = onBackgroundError;
    }

    /** The cached list, empty before the first load. A stale list starts a background reload. */
    snapshot(): readonly SessionInfo[] {
        const stale = Date.now() - this.loadedAt > REFRESH_AFTER_MS;
        if (stale && !this.loading && !this.abort.signal.aborted) {
            this.reload().catch((error: unknown) => {
                if (!this.abort.signal.aborted) this.onBackgroundError(error);
            });
        }
        return this.sessions;
    }

    /** Waits only for the first load; later lookups return the cached list at once. */
    async list(): Promise<readonly SessionInfo[]> {
        return this.loaded ? this.snapshot() : this.reload();
    }

    /** Concurrent callers share one load. */
    reload(): Promise<readonly SessionInfo[]> {
        this.loadedAt = Date.now();
        this.loading ??= listSessions(this.sessionDir, this.abort.signal)
            .then((sessions) => {
                this.abort.signal.throwIfAborted();
                this.sessions = sessions;
                this.loaded = true;
                return sessions;
            })
            .finally(() => {
                this.loading = undefined;
            });
        return this.loading;
    }

    dispose(): void {
        this.abort.abort();
    }
}

function listSessions(sessionDir: string, signal: AbortSignal): Promise<SessionInfo[]> {
    // Matches the "all" scope of /resume: the default store keeps one folder per project under
    // the agent's sessions root, and a custom session directory holds every session itself.
    const root = join(getAgentDir(), "sessions");
    const custom = sessionDir !== "" && resolve(dirname(sessionDir)) !== resolve(root);
    return custom
        ? SessionManager.listAll(sessionDir, undefined, signal)
        : SessionManager.listAll(undefined, signal);
}
