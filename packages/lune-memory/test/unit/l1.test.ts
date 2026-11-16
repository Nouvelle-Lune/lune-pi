import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";
import { MEMORY_CONTEXT_TAG, type Item } from "../../src/core/types.ts";
import {
    L1_MAX_BYTES,
    L1_MAX_LINES,
    L1_RECENT_LIMIT,
    L1_RESERVE_BYTES,
    L1_RESERVE_LINES,
    assembleL1,
    stableL1Size,
} from "../../src/memory/l1.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { Store } from "../../src/store/db.ts";
import { putItem } from "../../src/store/rows.ts";
import { createRepo, makeItem, seedSession } from "../harness/memory.ts";

let root: string;
let repo: string;
let paths: MemoryPaths;
let store: Store;
let resolver: ProjectResolver;
let projectId: string;

before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lune-memory-test-")));
    repo = createRepo(join(root, "repo"));
    paths = memoryPaths(join(root, "home"));
});

after(() => {
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    store = Store.open(":memory:");
    resolver = new ProjectResolver(store);
    const resolution = resolver.resolve(repo);
    assert.ok(resolution);
    projectId = resolution.projectId;
});

afterEach(() => {
    store.close();
});

function add(overrides: Partial<Item>): Item {
    const item = makeItem({ projectId, ...overrides });
    putItem(store, item);
    return item;
}

describe("assembleL1", () => {
    it("contains the stable sections, recent sessions and guidance for a project", () => {
        add({
            scope: "global",
            projectId: null,
            kind: "preference",
            title: "Be brief",
            body: "Short answers.",
        });
        add({ kind: "index", title: "Index", body: "Project overview text." });
        add({
            kind: "preference",
            title: "Use tabs",
            body: "Indent with four spaces.",
            trust: "tool",
        });
        add({ kind: "working_state", title: "Now", body: "Fixing the parser.", branch: "main" });
        add({
            kind: "working_state",
            title: "Side",
            body: "Refactor started. More later.",
            branch: "feat-a",
        });
        store.run(
            "INSERT INTO branches(project_id, name, status, first_seen) VALUES (?, 'feat-a', 'open', 'x')",
            projectId,
        );
        seedSession(store, { id: "other", projectId, harness: "claude", events: [{ text: "hi" }] });

        const l1 = assembleL1(store, paths, resolver, repo, { harness: "pi", sessionId: "me" });

        assert.equal(l1.projectId, projectId);
        assert.equal(l1.branch, "main");
        assert.equal(l1.overBudget, false);
        assert.ok(l1.text.startsWith(`<${MEMORY_CONTEXT_TAG}>\n# Lune Memory\n`));
        assert.ok(l1.text.endsWith(`</${MEMORY_CONTEXT_TAG}>\n`));
        for (const expected of [
            "## Global preferences\n- Be brief: Short answers.",
            "## Project: repo\nProject overview text.",
            "## Project preferences\n- Use tabs: Indent with four spaces. (trust tool)",
            "## Working State of branch main\n### Now\nFixing the parser.",
            "## Other active branches\n- feat-a: Refactor started. Read more:",
            "## Recent sessions not yet in memory\n- claude ",
            "## How to use this memory",
            "This session id is me.",
        ]) {
            assert.ok(l1.text.includes(expected), `missing: ${expected}`);
        }
    });

    it("says what is missing when Dreaming has written nothing yet", () => {
        const l1 = assembleL1(store, paths, resolver, repo);

        assert.ok(l1.text.includes("No Project Index yet."));
        assert.ok(l1.text.includes("No Working State recorded for this branch yet."));
        assert.ok(!l1.text.includes("This session id is"));
    });

    it("leaves out the session announcement on request and lists other sessions only", () => {
        seedSession(store, { id: "me", projectId, events: [{ text: "mine" }] });
        seedSession(store, { id: "other", projectId, harness: "codex", events: [{ text: "x" }] });

        const l1 = assembleL1(store, paths, resolver, repo, {
            harness: "pi",
            sessionId: "me",
            announceSession: false,
        });

        assert.ok(!l1.text.includes("This session id is"));
        const recent = l1.text.split("## Recent sessions not yet in memory")[1] ?? "";
        assert.ok(recent.includes("- codex "));
        assert.ok(!recent.includes("- pi "));
    });

    it("lists at most ten unprocessed sessions and counts the rest, skipping processed ones", () => {
        for (let i = 0; i < L1_RECENT_LIMIT + 3; i++) {
            seedSession(store, { id: `s${i}`, projectId, events: [{ text: "x" }] });
        }
        seedSession(store, { id: "done", projectId, processed: true, events: [{ text: "x" }] });

        const l1 = assembleL1(store, paths, resolver, repo);

        const lines = l1.text.split("\n").filter((line) => line.startsWith("- pi "));
        assert.equal(lines.length, L1_RECENT_LIMIT);
        assert.ok(l1.text.includes("- 3 more. Use transcript_search to find them."));
    });

    it("gives only global preferences and the sessions of the cwd outside any project", () => {
        const plain = join(root, "plain");
        add({
            scope: "global",
            projectId: null,
            kind: "preference",
            title: "Global",
            body: "Pref.",
        });
        seedSession(store, { id: "u1", cwd: plain, events: [{ text: "x" }] });
        seedSession(store, { id: "u2", cwd: join(root, "elsewhere"), events: [{ text: "x" }] });

        const l1 = assembleL1(store, paths, resolver, plain);

        assert.equal(l1.projectId, null);
        assert.ok(l1.text.includes("## Global preferences"));
        assert.ok(!l1.text.includes("## Project:"));
        assert.ok(l1.text.includes("## Recent sessions not yet in memory"));
        assert.equal(l1.text.split("\n").filter((line) => line.startsWith("- pi ")).length, 1);
    });
});

describe("stableL1Size", () => {
    it("fits when the stable part stays within the budget less the reserve", () => {
        add({ kind: "index", title: "Index", body: "Short overview." });

        const size = stableL1Size(store, paths, projectId);

        assert.equal(size.fits, true);
    });

    it("does not fit when the lines exceed the budget less the 30-line reserve", () => {
        const allowed = L1_MAX_LINES - L1_RESERVE_LINES;
        const index = (count: number): string =>
            Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
        // Project heading, blank separator and the two-line empty Working State add four lines.
        add({ kind: "index", title: "Index", body: index(allowed - 4) });
        const atLimit = stableL1Size(store, paths, projectId);
        store.run("DELETE FROM items");
        add({ kind: "index", title: "Index", body: index(allowed - 3) });

        const over = stableL1Size(store, paths, projectId);

        assert.deepEqual([atLimit.lines, atLimit.fits], [allowed, true]);
        assert.deepEqual([over.lines, over.fits], [allowed + 1, false]);
    });

    it("does not fit when the bytes exceed the budget less the 4 KB reserve", () => {
        const allowed = L1_MAX_BYTES - L1_RESERVE_BYTES;
        add({ kind: "index", title: "Index", body: "x".repeat(allowed + 1) });

        const size = stableL1Size(store, paths, projectId);

        assert.ok(size.bytes > allowed);
        assert.equal(size.fits, false);
    });

    it("measures the largest branch of the project", () => {
        add({
            kind: "working_state",
            title: "Big",
            body: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
            branch: "feat-big",
        });
        store.run(
            "INSERT INTO branches(project_id, name, status, first_seen) VALUES (?, 'feat-big', 'open', 'x')",
            projectId,
        );

        const size = stableL1Size(store, paths, projectId);

        assert.equal(size.branch, "feat-big");
    });
});
