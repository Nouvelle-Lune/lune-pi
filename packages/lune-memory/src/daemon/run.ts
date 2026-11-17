import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { Models } from "@earendil-works/pi-ai";
import type { FastifyInstance } from "fastify";

import { removeDaemonInfo, writeDaemonInfo, type DaemonInfo } from "../api/daemon-info.ts";
import { memoryHome } from "../core/config.ts";
import { memoryPaths, type MemoryPaths } from "../core/paths.ts";
import { packageVersion, takePidLock } from "../core/util.ts";
import { MemoryService } from "../service.ts";
import { DaemonScheduler, type DaemonLog } from "./scheduler.ts";
import { createApp } from "./server.ts";

/** Another daemon holds the lock of this memory home. */
export class DaemonRunningError extends Error {
    readonly holder: number | null;

    constructor(holder: number | null) {
        super(
            holder
                ? `A lune-memory daemon already runs with process id ${holder}`
                : "A lune-memory daemon already runs",
        );
        this.name = "DaemonRunningError";
        this.holder = holder;
    }
}

export interface StartDaemonOptions {
    home?: string;
    /** Port on 127.0.0.1. The default 0 takes a free port. */
    port?: number;
    models?: Models;
    log?: DaemonLog;
    /** Start the import and scan timers. Default true. */
    schedule?: boolean;
}

export interface RunningDaemon {
    app: FastifyInstance;
    info: DaemonInfo;
    service: MemoryService;
    scheduler: DaemonScheduler;
    paths: MemoryPaths;
    stop: () => Promise<void>;
}

/** Start the daemon in this process. It holds daemon.lock until stop(). */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
    const home = options.home ?? memoryHome();
    const paths = memoryPaths(home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const lock = takePidLock(paths.lock);
    if (!("release" in lock)) throw new DaemonRunningError(lock.holder);

    let service: MemoryService | null = null;
    let app: FastifyInstance | null = null;
    try {
        service = MemoryService.open(home, options.models ? { models: options.models } : {});
        const runningService = service;
        const log: DaemonLog = (message, details) => {
            runningService.log(message, details);
            options.log?.(message, details);
        };
        const token = randomBytes(32).toString("base64url");
        const version = packageVersion();
        const startedAt = new Date().toISOString();
        const scheduler = new DaemonScheduler(service, log);
        app = createApp(service, { token, version, scheduler, log, startedAt });
        await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
        const info: DaemonInfo = {
            pid: process.pid,
            port,
            token,
            url: `http://127.0.0.1:${port}`,
            startedAt,
            version,
        };
        writeDaemonInfo(paths, info);
        if (options.schedule ?? true) scheduler.start();

        const runningApp = app;
        let stopping: Promise<void> | null = null;
        const stop = (): Promise<void> =>
            (stopping ??= (async () => {
                try {
                    await scheduler.stop();
                    await runningApp.close();
                } finally {
                    removeDaemonInfo(paths, process.pid);
                    lock.release();
                    runningService.close();
                }
            })());
        return { app: runningApp, info, service: runningService, scheduler, paths, stop };
    } catch (error) {
        await app?.close().catch(() => {});
        service?.close();
        lock.release();
        throw error;
    }
}
