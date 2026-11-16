import { RequestError } from "../api/requests.ts";
import { errorMessage } from "../core/util.ts";
import type { PassSummary } from "../dreaming/index.ts";
import type { DreamRequest, MemoryService } from "../service.ts";

export type DaemonLog = (message: string) => void;

/**
 * Timers of the daemon: a regular import of new transcripts and a regular Dreaming scan. A
 * manual pass goes through the scheduler too, so stop() can abort and wait for every pass.
 */
export class DaemonScheduler {
    private readonly controller = new AbortController();
    private readonly active = new Set<Promise<PassSummary>>();
    private timers: NodeJS.Timeout[] = [];
    private importing = false;
    private stopped = false;
    private unsubscribe: (() => void) | null = null;
    private readonly service: MemoryService;
    private readonly log: DaemonLog;

    constructor(service: MemoryService, log: DaemonLog = () => {}) {
        this.service = service;
        this.log = log;
    }

    /** True while a Dreaming pass runs. */
    get busy(): boolean {
        return this.active.size > 0;
    }

    start(): void {
        if (this.stopped || this.unsubscribe) return;
        this.unsubscribe = this.service.on((event) => {
            if (event.type === "config" && "config" in event.data) this.schedule();
        });
        this.schedule();
    }

    private schedule(): void {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers = [];
        if (this.stopped) return;
        const config = this.service.getConfig();
        this.timers.push(
            setTimeout(() => this.runImport(), 1000),
            setInterval(() => this.runImport(), config.importSeconds * 1000),
            setInterval(() => void this.runScan(), config.dreaming.scanMinutes * 60_000),
        );
    }

    /** Import new transcripts. It skips while another import or a pass runs. */
    runImport(): void {
        if (this.stopped || this.importing || this.busy) return;
        this.importing = true;
        try {
            this.service.importNow();
        } catch (error) {
            this.log(`Import failed: ${errorMessage(error)}`);
        } finally {
            this.importing = false;
        }
    }

    /** Scheduled Dreaming pass. It runs only with Dreaming on, a model set and no pass active. */
    async runScan(): Promise<PassSummary | null> {
        const config = this.service.getConfig();
        if (this.stopped || this.busy || !config.dreaming.enabled || !config.dreaming.model) {
            return null;
        }
        const summary = await this.dream({ trigger: "scan" });
        if (summary.status === "failed") this.log(`Scan pass failed: ${summary.errors.join("; ")}`);
        return summary;
    }

    /** Run one pass with the abort signal of the daemon. */
    dream(request: Omit<DreamRequest, "signal"> = {}): Promise<PassSummary> {
        if (this.stopped) return Promise.reject(new RequestError("The daemon is stopping", 503));
        const run = this.service.dream({
            ...request,
            importFirst: !this.busy && (request.importFirst ?? true),
            signal: this.controller.signal,
        });
        this.active.add(run);
        const done = (): void => {
            this.active.delete(run);
        };
        run.then(done, done);
        return run;
    }

    /** Stop the timers, abort the passes and wait for them. */
    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers = [];
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.controller.abort();
        await Promise.allSettled([...this.active]);
    }
}
