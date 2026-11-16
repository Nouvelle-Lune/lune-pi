import { readDaemonInfo, type DaemonInfo } from "../api/daemon-info.ts";
import {
    searchArguments,
    type L1Request,
    type NoteUpdateRequest,
    type SearchRequest,
    type WriterRequest,
} from "../api/requests.ts";
import { memoryHome } from "../core/config.ts";
import { memoryPaths, type MemoryPaths } from "../core/paths.ts";
import type { L1Result } from "../memory/l1.ts";
import type { NoteInput, NoteResult } from "../memory/notes.ts";
import type { SearchResult } from "../memory/search.ts";
import type { MemoryLocation, MemoryService } from "../service.ts";
import {
    daemonRequest,
    DaemonUnavailableError,
    ensureDaemon,
    REQUEST_TIMEOUT_MS,
} from "./connection.ts";

/** At most one start attempt in this time, so a broken install does not spawn in a loop. */
const START_RETRY_MS = 60_000;

/** Operations that agents use. The daemon serves them, or a local service when it does not run. */
export interface MemoryBackend {
    l1(request: L1Request): Promise<L1Result>;
    noteWrite(input: NoteInput): Promise<NoteResult>;
    noteUpdate(id: string, request: NoteUpdateRequest): Promise<NoteResult>;
    noteRetract(id: string, writer: WriterRequest): Promise<NoteResult>;
    search(request: SearchRequest): Promise<SearchResult>;
    location(cwd?: string | null): Promise<MemoryLocation>;
    close(): Promise<void>;
}

export interface MemoryClientOptions {
    home?: string;
    /** Start the daemon when it does not run. The default comes from the config. */
    autoStart?: boolean;
    /** Use the local service when no daemon is available. Default true. */
    localFallback?: boolean;
}

/**
 * Client of the daemon. It falls back to a local MemoryService only when the daemon refuses the
 * connection, so a request that can have reached the daemon never runs two times.
 */
export class MemoryClient implements MemoryBackend {
    readonly paths: MemoryPaths;
    private readonly autoStart: boolean | undefined;
    private readonly localFallback: boolean;
    private local: MemoryService | null = null;
    private lastStart = 0;

    constructor(options: MemoryClientOptions = {}) {
        this.paths = memoryPaths(options.home ?? memoryHome());
        this.autoStart = options.autoStart;
        this.localFallback = options.localFallback ?? true;
    }

    /** Connection data of the daemon. It starts the daemon at most once a minute. */
    async daemon(): Promise<DaemonInfo | null> {
        const running = readDaemonInfo(this.paths);
        if (running) return running;
        if (Date.now() - this.lastStart < START_RETRY_MS) return null;
        this.lastStart = Date.now();
        return ensureDaemon(this.paths, {
            ...(this.autoStart !== undefined ? { autoStart: this.autoStart } : {}),
        });
    }

    /** The local service. It opens on first use. */
    async localService(): Promise<MemoryService> {
        if (!this.local) {
            const { MemoryService: Service } = await import("../service.ts");
            this.local = Service.open(this.paths.home);
        }
        return this.local;
    }

    /** Call the daemon, or run `localFn` on the local service when no daemon is available. */
    async call<T>(
        method: string,
        path: string,
        body: unknown,
        localFn: (service: MemoryService) => T | Promise<T>,
        timeoutMs: number = REQUEST_TIMEOUT_MS,
    ): Promise<T> {
        const info = await this.daemon();
        if (info) {
            try {
                return await daemonRequest<T>(info, method, path, body, timeoutMs);
            } catch (error) {
                if (!(error instanceof DaemonUnavailableError) || !this.localFallback) throw error;
            }
        }
        if (!this.localFallback) throw new DaemonUnavailableError();
        return localFn(await this.localService());
    }

    l1(request: L1Request): Promise<L1Result> {
        return this.call("POST", "/api/l1", request, (service) => service.l1(request));
    }

    noteWrite(input: NoteInput): Promise<NoteResult> {
        return this.call("POST", "/api/notes", input, (service) => service.noteWrite(input));
    }

    noteUpdate(id: string, request: NoteUpdateRequest): Promise<NoteResult> {
        return this.call("PUT", `/api/notes/${encodeURIComponent(id)}`, request, (service) =>
            service.noteUpdate(id, request),
        );
    }

    noteRetract(id: string, writer: WriterRequest): Promise<NoteResult> {
        return this.call(
            "POST",
            `/api/notes/${encodeURIComponent(id)}/retract`,
            writer,
            (service) => service.noteRetract(id, writer),
        );
    }

    search(request: SearchRequest): Promise<SearchResult> {
        return this.call("POST", "/api/search", request, (service) =>
            service.search(searchArguments(request)),
        );
    }

    location(cwd?: string | null): Promise<MemoryLocation> {
        return this.call("POST", "/api/location", { cwd: cwd ?? null }, (service) =>
            service.location(cwd ?? null),
        );
    }

    async close(): Promise<void> {
        this.local?.close();
        this.local = null;
    }
}
