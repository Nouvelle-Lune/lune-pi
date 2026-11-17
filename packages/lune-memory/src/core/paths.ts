import { join } from "node:path";

import type { Harness } from "./types.ts";
import { safeSegment } from "./util.ts";

/** Folder name for transcripts of sessions that are not in a project. */
export const UNASSIGNED = "_unassigned";

export interface MemoryPaths {
    home: string;
    db: string;
    config: string;
    /** Model credentials of lune-memory. Mode 0600. */
    credentials: string;
    /** Custom providers and their models, in the format of the models.json of Pi. */
    models: string;
    /** Port and token of the running daemon. Mode 0600. */
    daemon: string;
    lock: string;
    /** Symlink to the current projection generation. Read-only for users and agents. */
    views: string;
    generations: string;
    /** L4 transcript views. They live outside the generations and change at import. */
    transcripts: string;
    logs: string;
}

export function memoryPaths(home: string): MemoryPaths {
    return {
        home,
        db: join(home, "memory.db"),
        config: join(home, "config.json"),
        credentials: join(home, "credentials.json"),
        models: join(home, "models.json"),
        daemon: join(home, "daemon.json"),
        lock: join(home, "daemon.lock"),
        views: join(home, "views"),
        generations: join(home, ".generations"),
        transcripts: join(home, "transcripts"),
        logs: join(home, "logs"),
    };
}

export function projectTranscriptDir(paths: MemoryPaths, projectId: string | null): string {
    return join(paths.transcripts, projectId ? safeSegment(projectId) : UNASSIGNED);
}

export function transcriptFile(
    paths: MemoryPaths,
    projectId: string | null,
    harness: Harness,
    sessionId: string,
): string {
    return join(projectTranscriptDir(paths, projectId), harness, `${safeSegment(sessionId)}.md`);
}

/** Paths of one project inside the current views. */
export function projectViewPaths(paths: MemoryPaths, projectId: string) {
    const root = join(paths.views, "projects", safeSegment(projectId));
    return {
        root,
        index: join(root, "index.md"),
        wiki: join(root, "wiki"),
        notes: join(root, "notes"),
        transcripts: join(root, "transcripts"),
    };
}

export function globalViewPaths(paths: MemoryPaths) {
    const root = join(paths.views, "global");
    return { root, index: join(root, "index.md"), notes: join(root, "notes") };
}
