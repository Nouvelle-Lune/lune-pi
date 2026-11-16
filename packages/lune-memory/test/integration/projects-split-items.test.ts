import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Item, SourceRef } from "../../src/core/types.ts";
import { getItem, listEvents, putItem } from "../../src/store/rows.ts";
import { createMemoryEnv, createRepo, makeItem, type MemoryEnv } from "../harness/memory.ts";

let env: MemoryEnv;
let shared: string;
let moved: string;

beforeEach(async () => {
    env = await createMemoryEnv();
    const remote = "https://example.invalid/org/repo.git";
    const cloneA = createRepo(env.folder("clone-a"), { remote });
    const cloneB = createRepo(env.folder("clone-b"), { remote });
    for (const [id, cwd] of [
        ["s-a", cloneA],
        ["s-b", cloneB],
    ] as const) {
        env.writePiSession({ id, cwd, messages: [{ role: "user", text: `hello from ${id}` }] });
    }
    env.importNow();
    const resolution = env.service.resolver.resolve(cloneA);
    assert.ok(resolution);
    shared = resolution.projectId;
    const commonDir = env.service
        .projects()
        .flatMap((project) => project.locators)
        .find((locator) => locator.kind === "git_common_dir" && locator.value.includes("clone-a"));
    assert.ok(commonDir);
    moved = commonDir.value;
});

afterEach(() => {
    env.cleanup();
});

function evidence(sessionId: string): SourceRef {
    const [event] = listEvents(env.store, "pi", sessionId);
    assert.ok(event, `no event for ${sessionId}`);
    return { kind: "event", harness: "pi", sessionId, eventKey: event.key };
}

function add(overrides: Partial<Item>): Item {
    const item = makeItem({ projectId: shared, ...overrides });
    putItem(env.store, item);
    return item;
}

describe("a project split moves the items of the moved sessions", () => {
    it("moves an item whose evidence is all in the moved session", () => {
        const item = add({ title: "All moved", sources: [evidence("s-a")] });

        const result = env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(getItem(env.store, item.id)?.projectId, result.project.id);
    });

    it("keeps an item with evidence from a session that stays too", () => {
        const item = add({ title: "Mixed", sources: [evidence("s-a"), evidence("s-b")] });

        env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(getItem(env.store, item.id)?.projectId, shared);
    });

    it("keeps an item whose evidence is only in the session that stays", () => {
        const item = add({ title: "Stays", sources: [evidence("s-b")] });

        env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(getItem(env.store, item.id)?.projectId, shared);
    });

    it("moves an item with no event evidence when a moved session wrote it", () => {
        const item = add({
            title: "Writer moved",
            origin: "agent_note",
            writerHarness: "pi",
            writerSession: "s-a",
        });

        const result = env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(getItem(env.store, item.id)?.projectId, result.project.id);
    });

    it("keeps an item with no event evidence when a session that stays wrote it", () => {
        const item = add({
            title: "Writer stays",
            origin: "agent_note",
            writerHarness: "pi",
            writerSession: "s-b",
        });

        env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(getItem(env.store, item.id)?.projectId, shared);
    });

    it("reports the number of moved items next to the moved sessions", () => {
        add({ title: "One", sources: [evidence("s-a")] });
        add({ title: "Two", origin: "agent_note", writerHarness: "pi", writerSession: "s-a" });
        add({ title: "Stays", sources: [evidence("s-a"), evidence("s-b")] });

        const result = env.service.split("git_common_dir", moved, "Clone A");

        assert.equal(result.moved, 1);
        assert.equal(result.items, 2);
    });
});
