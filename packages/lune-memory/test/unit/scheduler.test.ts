import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { LogDetails } from "../../src/core/log.ts";
import { DaemonScheduler } from "../../src/daemon/scheduler.ts";
import type { PassSummary } from "../../src/dreaming/index.ts";
import type { MemoryService, ServiceEvent, ServiceListener } from "../../src/service.ts";

/** A service double with the four methods that the scheduler uses. */
class FakeService {
    config = {
        importSeconds: 60,
        dreaming: { enabled: true, model: "test/model" as string | null, scanMinutes: 10 },
    };
    imports = 0;
    importError: Error | null = null;
    repairs = 0;
    /** Result of repairViews(): an error text, or null when the views are fine. */
    repairResult: string | null = null;
    repairThrows: Error | null = null;
    dreams: Array<{ signal?: AbortSignal; importFirst?: boolean; trigger?: string }> = [];
    pending: Array<(summary: PassSummary) => void> = [];
    listeners = new Set<ServiceListener>();

    getConfig() {
        return structuredClone(this.config);
    }
    on(listener: ServiceListener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    importNow() {
        this.imports += 1;
        if (this.importError) throw this.importError;
    }
    repairViews(): string | null {
        this.repairs += 1;
        if (this.repairThrows) throw this.repairThrows;
        return this.repairResult;
    }
    dream(request: { signal?: AbortSignal; importFirst?: boolean; trigger?: string }) {
        this.dreams.push(request);
        return new Promise<PassSummary>((resolve, reject) => {
            this.pending.push(resolve);
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
    }
    emitConfig() {
        const event = { type: "config", at: "", data: { config: this.config } } as ServiceEvent;
        for (const listener of this.listeners) listener(event);
    }
}

function summary(status: PassSummary["status"]): PassSummary {
    return { status, errors: ["boom"] } as unknown as PassSummary;
}

let service: FakeService;
let logs: string[];
let contexts: Array<LogDetails | undefined>;
let scheduler: DaemonScheduler;

beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    service = new FakeService();
    logs = [];
    contexts = [];
    scheduler = new DaemonScheduler(service as unknown as MemoryService, (message, details) => {
        logs.push(message);
        contexts.push(details);
    });
});

afterEach(async () => {
    await scheduler.stop().catch(() => {});
    mock.timers.reset();
});

describe("timers", () => {
    it("imports once after a second and then every importSeconds", () => {
        scheduler.start();
        mock.timers.tick(1000);
        assert.equal(service.imports, 1);
        mock.timers.tick(60_000 - 1000);
        assert.equal(service.imports, 2);
    });

    it("does not start twice", () => {
        scheduler.start();
        scheduler.start();
        mock.timers.tick(1000);
        assert.equal(service.imports, 1);
    });

    it("stops all timers on stop()", async () => {
        scheduler.start();
        await scheduler.stop();
        mock.timers.tick(10 * 60_000);
        assert.equal(service.imports, 0);
        assert.equal(service.dreams.length, 0);
    });

    it("applies new intervals when a config event arrives", () => {
        scheduler.start();
        service.config.importSeconds = 10;
        service.emitConfig();
        mock.timers.tick(10_000);
        assert.equal(service.imports, 2); // The one-second timer and the first 10 second tick.
    });

    it("logs an import failure and keeps running", () => {
        service.importError = new Error("disk gone");
        scheduler.runImport();
        service.importError = null;
        scheduler.runImport();
        assert.deepEqual(logs, ["Import failed: disk gone"]);
        assert.equal(service.imports, 2);
    });
});

describe("passes", () => {
    it("runs the timed import while a pass waits for the model", async () => {
        const run = scheduler.dream({ trigger: "manual" });
        assert.equal(scheduler.busy, true);
        scheduler.runImport();
        assert.equal(service.imports, 1);

        service.pending[0]?.(summary("ok"));
        await run;
        assert.equal(scheduler.busy, false);
        scheduler.runImport();
        assert.equal(service.imports, 2);
    });

    it("skips an import while another import runs", () => {
        service.importNow = () => {
            service.imports += 1;
            scheduler.runImport(); // Re-entrant call while the first import is active.
        };
        scheduler.runImport();
        assert.equal(service.imports, 1);
    });

    it("keeps importFirst and passes the abort signal for a pass that overlaps", async () => {
        const first = scheduler.dream();
        const second = scheduler.dream();
        assert.equal(service.dreams[0]?.importFirst, true);
        assert.equal(service.dreams[1]?.importFirst, true);
        assert.ok(service.dreams[0]?.signal instanceof AbortSignal);
        assert.ok(service.dreams[1]?.signal instanceof AbortSignal);
        for (const resolve of service.pending) resolve(summary("ok"));
        await Promise.all([first, second]);
    });

    it("respects an explicit importFirst false", async () => {
        const run = scheduler.dream({ importFirst: false });
        assert.equal(service.dreams[0]?.importFirst, false);
        service.pending[0]?.(summary("ok"));
        await run;
    });

    it("scan needs Dreaming enabled and a model", async () => {
        service.config.dreaming.model = null;
        assert.equal(await scheduler.runScan(), null);
        service.config.dreaming.model = "test/model";
        service.config.dreaming.enabled = false;
        assert.equal(await scheduler.runScan(), null);
        assert.equal(service.dreams.length, 0);
    });

    it("scan skips while a pass is active and otherwise runs a scan pass", async () => {
        const manual = scheduler.dream();
        assert.equal(await scheduler.runScan(), null);
        service.pending[0]?.(summary("ok"));
        await manual;

        const scan = scheduler.runScan();
        assert.equal(service.dreams.at(-1)?.trigger, "scan");
        service.pending[1]?.(summary("failed"));
        assert.equal((await scan)?.status, "failed");
        assert.deepEqual(logs, ["Scan pass failed: boom"]);
    });

    it("stop() aborts the active pass and waits for it", async () => {
        const run = scheduler.dream();
        const rejected = assert.rejects(run, /aborted/u);
        await scheduler.stop();
        await rejected;
        assert.equal(scheduler.busy, false);
    });

    it("refuses a new pass after stop() with status 503", async () => {
        await scheduler.stop();
        await assert.rejects(scheduler.dream(), (error: Error & { status?: number }) => {
            assert.equal(error.status, 503);
            return true;
        });
        assert.equal(await scheduler.runScan(), null);
    });
});

describe("view repair", () => {
    it("repairs the views after each import", () => {
        scheduler.runImport();
        scheduler.runImport();
        assert.equal(service.repairs, 2);
        assert.deepEqual(logs, []);
    });

    it("logs a repair error once, not again for the same error", () => {
        service.repairResult = "disk full";
        scheduler.runImport();
        scheduler.runImport();
        assert.deepEqual(logs, ["Views are out of date: disk full"]);
    });

    it("logs a different repair error again", () => {
        service.repairResult = "disk full";
        scheduler.runImport();
        service.repairResult = "permission denied";
        scheduler.runImport();
        assert.deepEqual(logs, [
            "Views are out of date: disk full",
            "Views are out of date: permission denied",
        ]);
    });

    it("logs the recovery once", () => {
        service.repairResult = "disk full";
        scheduler.runImport();
        service.repairResult = null;
        scheduler.runImport();
        scheduler.runImport();
        assert.deepEqual(logs, ["Views are out of date: disk full", "Views are up to date again"]);
    });

    it("logs a repair that throws and keeps running", () => {
        service.repairThrows = new Error("boom");
        scheduler.runImport();
        assert.deepEqual(logs, ["Views are out of date: boom"]);
        service.repairThrows = null;
        scheduler.runImport();
        assert.equal(service.repairs, 2);
    });
});

describe("log metadata", () => {
    it("labels import, view and scan logs with their level and source", async () => {
        service.importError = new Error("disk gone");
        scheduler.runImport();
        service.importError = null;
        service.repairResult = "disk full";
        scheduler.runImport();
        service.repairResult = null;
        scheduler.runImport();
        const scan = scheduler.runScan();
        service.pending[0]?.(summary("failed"));
        await scan;

        const expected = [
            { level: "error", source: "import" },
            { level: "warn", source: "views" },
            { level: "info", source: "views" },
            { level: "error", source: "dreaming" },
        ];
        assert.deepEqual(contexts, expected);
    });
});
