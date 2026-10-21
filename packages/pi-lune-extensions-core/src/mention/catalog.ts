import { dirname, join, resolve } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { ExternalSessions } from "./external.ts";
import type { LocalSession } from "./session.ts";

/** A list older than this is reloaded in the background on the next lookup. */
const REFRESH_AFTER_MS = 60_000;

/**
 * Local Pi, Codex and Claude Code main sessions, newest activity first.
 *
 * Listing reads every session file (about a second for a few hundred sessions), so lookups
 * serve the cached list and reload it in the background. The owner disposes the catalog on
 * session shutdown; a load that finishes later is discarded.
 */
export class SessionCatalog {
    private readonly sessionDir: string;
    private readonly onBackgroundError: (error: unknown) => void;
    private readonly abort = new AbortController();
    private readonly external = new ExternalSessions();
    private sessions: readonly LocalSession[] = [];
    private loaded = false;
    private loadedAt = 0;
    private loading: Promise<readonly LocalSession[]> | undefined;

    constructor(sessionDir: string, onBackgroundError: (error: unknown) => void) {
        this.sessionDir = sessionDir;
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

    /** Concurrent callers share one load. */
    reload(): Promise<readonly LocalSession[]> {
        this.loadedAt = Date.now();
        this.loading ??= Promise.all([
            listSessions(this.sessionDir, this.abort.signal),
            this.external.list(this.abort.signal, this.onBackgroundError),
        ])
            .then(([pi, external]) => {
                this.abort.signal.throwIfAborted();
                const sessions = [
                    ...pi.map((session): LocalSession => ({ ...session, source: "pi" })),
                    ...external,
                ].sort((left, right) => right.modified.getTime() - left.modified.getTime());
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
        this.external.clear();
    }
}

function listSessions(sessionDir: string, signal: AbortSignal) {
    // Matches the "all" scope of /resume: the default store keeps one folder per project under
    // the agent's sessions root, and a custom session directory holds every session itself.
    const root = join(getAgentDir(), "sessions");
    const custom = sessionDir !== "" && resolve(dirname(sessionDir)) !== resolve(root);
    return custom
        ? SessionManager.listAll(sessionDir, undefined, signal)
        : SessionManager.listAll(undefined, signal);
}
