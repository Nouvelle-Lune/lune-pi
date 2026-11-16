import type { Item } from "../core/types.ts";
import { nowIso } from "../core/util.ts";
import type { Store } from "../store/db.ts";
import { getEvent, getItem, getSession, putItem, recordHistory, sourceKey } from "../store/rows.ts";
import type { AnalyzerResult } from "./analyzer.ts";
import { eventId, eventSource, liveEvents, sessionSources } from "./evidence.ts";

/** Settle invalidated citations in every scope reached by the session's review. */
export function reviewEarlier(
    store: Store,
    result: AnalyzerResult,
    runId: number,
    now: number,
    touched: ReadonlySet<string> = new Set(),
): { retired: number; warnings: string[]; itemIds: string[]; pending: boolean } {
    const { snapshot } = result;
    const outcome = {
        retired: 0,
        warnings: [] as string[],
        itemIds: [] as string[],
        pending: false,
    };
    if (
        getSession(store, snapshot.session.harness, snapshot.session.id)?.revision !==
        snapshot.revision
    ) {
        outcome.pending = snapshot.review.size > 0;
        return outcome;
    }
    const unsupported = new Set(result.unsupported.map((entry) => entry.id));
    const shown = new Set(snapshot.events.map(({ event }) => eventId(event)));
    const save = (before: Item, after: Item): void => {
        putItem(store, after);
        recordHistory(store, runId, after.id, before, after);
        outcome.itemIds.push(after.id);
    };
    for (const id of snapshot.review) {
        const item = getItem(store, id);
        if (!item || item.status !== "active") continue;
        const changed = item.sources.some((source) => {
            if (source.kind !== "event" || !snapshot.itemPins.has(sourceKey(source))) return false;
            const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
            return (event?.hash ?? null) !== snapshot.itemPins.get(sourceKey(source));
        });
        if (changed) {
            outcome.pending = true;
            outcome.warnings.push(`Review of ${id} waits: its evidence changed during the pass.`);
            continue;
        }
        const cited = sessionSources(item.sources, snapshot.session);
        const kept = liveEvents(store, cited, undefined, item.kind);
        if (kept.length === cited.length) continue;
        const live = liveEvents(store, item.sources, undefined, item.kind);
        const elsewhere = live.length > kept.length;
        const after = { ...item, updatedRun: runId, updatedAt: nowIso(now) };
        if (unsupported.has(id) && !touched.has(id)) {
            if (!elsewhere && kept.every((event) => shown.has(eventId(event)))) {
                save(item, { ...after, status: "retired" });
                outcome.retired++;
                continue;
            }
            const why = elsewhere
                ? "another session supports it"
                : "the pass did not show all its evidence";
            outcome.warnings.push(`Kept ${id}, which the Analyzer found unsupported: ${why}`);
        }
        const alive = new Set(kept.map((event) => sourceKey(eventSource(event))));
        const dead = new Set(cited.map(sourceKey).filter((key) => !alive.has(key)));
        const missing = live.length === 0;
        save(item, {
            ...after,
            sources: missing
                ? item.sources
                : item.sources.filter((source) => !dead.has(sourceKey(source))),
            status: missing ? "source-missing" : item.status,
        });
    }
    return outcome;
}
