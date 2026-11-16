import { MemoryOperationError } from "../core/errors.ts";
import {
    NOTE_KINDS,
    type Harness,
    type Item,
    type ItemKind,
    type SourceRef,
    type Trust,
} from "../core/types.ts";
import { newId, nowIso, sha256 } from "../core/util.ts";
import { redact } from "../ingest/redact.ts";
import type { ProjectResolver } from "../projects/resolver.ts";
import type { Store } from "../store/db.ts";
import { finishRun, getItem, putItem, recordHistory, startRun } from "../store/rows.ts";

export { NOTE_KINDS };

export interface NoteInput {
    title: string;
    body: string;
    kind?: ItemKind;
    trust?: Trust;
    /** Working folder of the writer. It selects the project and the branch. */
    cwd?: string | null;
    writerHarness?: Harness | null;
    writerSession?: string | null;
    sources?: SourceRef[];
    trigger?: string;
}

export interface NoteOptions {
    now?: () => number;
    /** Called after the commit, for example to add the note to the projection at once. */
    onCommit?: (item: Item) => void;
}

export function contentHash(title: string, body: string): string {
    return sha256(`${title}\n${body}`);
}

/**
 * Normalize and check the text of a note. Secrets are redacted first, like on import, so the
 * store, the views and the Dreaming model never see them.
 */
function checkText(input: { title: string; body: string }): { title: string; body: string } {
    const title = redact(input.title).text.replace(/\s+/gu, " ").trim();
    const body = redact(input.body).text.trim();
    if (!title) throw new MemoryOperationError("A note needs a title");
    if (!body) throw new MemoryOperationError("A note needs a body");
    if (title.length > 200)
        throw new MemoryOperationError("A note title has at most 200 characters");
    if (body.length > 20_000)
        throw new MemoryOperationError("A note body has at most 20000 characters");
    return { title, body };
}

/**
 * Write an Agentic Note. The note is provisional until Dreaming reviews it with the session
 * that wrote it. A cwd in a project gives a project note. Other notes are global candidates
 * that only the global pass can promote.
 */
export function writeNote(
    store: Store,
    resolver: ProjectResolver,
    input: NoteInput,
    options: NoteOptions = {},
): Item {
    const { title, body } = checkText(input);
    const kind = input.kind ?? "note";
    if (!NOTE_KINDS.includes(kind))
        throw new MemoryOperationError(`A note cannot have kind ${kind}`);
    const resolution = input.cwd ? resolver.resolve(input.cwd) : null;
    const at = nowIso((options.now ?? Date.now)());
    const item = store.tx(() => {
        const runId = startRun(store, {
            kind: "note",
            projectId: resolution?.projectId ?? null,
            trigger: input.trigger ?? "note_write",
        });
        const next: Item = {
            id: newId("n"),
            scope: resolution ? "project" : "global",
            projectId: resolution?.projectId ?? null,
            kind,
            title,
            body,
            branch: resolution?.branch ?? null,
            trust: input.trust ?? "inference",
            status: "provisional",
            origin: "agent_note",
            general: false,
            writerHarness: input.writerHarness ?? null,
            writerSession: input.writerSession ?? null,
            idemKey: null,
            contentHash: contentHash(title, body),
            createdRun: runId,
            updatedRun: runId,
            createdAt: at,
            updatedAt: at,
            sources: input.sources ?? [],
        };
        putItem(store, next);
        recordHistory(store, runId, next.id, null, next);
        finishRun(store, runId, { status: "ok" });
        return next;
    });
    options.onCommit?.(item);
    return item;
}

function ownNote(
    store: Store,
    id: string,
    writer: { harness?: Harness | null; session?: string | null },
): Item {
    const item = getItem(store, id);
    if (!item || item.origin !== "agent_note")
        throw new MemoryOperationError(`Unknown note: ${id}`);
    if (
        item.writerSession &&
        (item.writerSession !== writer.session || item.writerHarness !== writer.harness)
    ) {
        throw new MemoryOperationError(`Only the session that wrote note ${id} can change it`);
    }
    if (item.status === "retired") throw new MemoryOperationError(`Note ${id} is retired`);
    return item;
}

/** Replace the text of an own provisional note. A note that Dreaming accepted stays fixed. */
export function updateNote(
    store: Store,
    id: string,
    input: { title: string; body: string; harness?: Harness | null; session?: string | null },
    options: NoteOptions = {},
): Item {
    const { title, body } = checkText(input);
    const at = nowIso((options.now ?? Date.now)());
    const item = store.tx(() => {
        const before = ownNote(store, id, input);
        if (before.status !== "provisional") {
            throw new MemoryOperationError(
                `Note ${id} was reviewed. Write a new note to correct it.`,
            );
        }
        const runId = startRun(store, {
            kind: "note",
            projectId: before.projectId,
            trigger: "note_update",
        });
        const after: Item = {
            ...before,
            title,
            body,
            contentHash: contentHash(title, body),
            updatedRun: runId,
            updatedAt: at,
        };
        putItem(store, after);
        recordHistory(store, runId, id, before, after);
        finishRun(store, runId, { status: "ok" });
        return after;
    });
    options.onCommit?.(item);
    return item;
}

/** Retract an own note. The note is retired and leaves the projection. */
export function retractNote(
    store: Store,
    id: string,
    writer: { harness?: Harness | null; session?: string | null },
    options: NoteOptions = {},
): Item {
    const at = nowIso((options.now ?? Date.now)());
    const item = store.tx(() => {
        const before = ownNote(store, id, writer);
        const runId = startRun(store, {
            kind: "note",
            projectId: before.projectId,
            trigger: "note_retract",
        });
        const after: Item = { ...before, status: "retired", updatedRun: runId, updatedAt: at };
        putItem(store, after);
        recordHistory(store, runId, id, before, after);
        finishRun(store, runId, { status: "ok" });
        return after;
    });
    options.onCommit?.(item);
    return item;
}
