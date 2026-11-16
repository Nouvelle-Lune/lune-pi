import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { memoryPaths, transcriptFile, type MemoryPaths } from "../../src/core/paths.ts";
import { MEMORY_CONTEXT_TAG, type Item } from "../../src/core/types.ts";
import {
    L1_MAX_BYTES,
    L1_MAX_LINES,
    L1_RECENT_LIMIT,
    assembleL1,
    grownStableBranch,
    l1Reserve,
    stableL1Grew,
    stableL1Size,
    type StableL1Branch,
    type StableL1Size,
} from "../../src/memory/l1.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { Store } from "../../src/store/db.ts";
import { listItems, putItem } from "../../src/store/rows.ts";
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

    it("does not fit when the lines exceed the budget less the reserve", () => {
        const allowed = stableL1Size(store, paths, projectId).maxLines;
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

    it("does not fit when the bytes exceed the budget less the reserve", () => {
        const allowed = stableL1Size(store, paths, projectId).maxBytes;
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

describe("stableL1Size across branches", () => {
    function addBranchState(branch: string, body: string): void {
        add({ kind: "working_state", title: `State ${branch}`, body, branch });
        store.run(
            "INSERT INTO branches(project_id, name, status, first_seen) VALUES (?, ?, 'open', 'x')",
            projectId,
            branch,
        );
    }
    const manyShort = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n");
    const fewLong = Array.from({ length: 3 }, () => "y".repeat(3000)).join("\n");

    it("reports the most lines and the most bytes even when they come from different branches", () => {
        addBranchState("feat-lines", manyShort);
        const onlyLines = stableL1Size(store, paths, projectId);
        store.run("DELETE FROM items WHERE branch = 'feat-lines'");
        store.run("DELETE FROM branches");
        addBranchState("feat-bytes", fewLong);
        const onlyBytes = stableL1Size(store, paths, projectId);
        store.run("DELETE FROM items WHERE branch = 'feat-bytes'");
        store.run("DELETE FROM branches");
        assert.ok(onlyLines.lines > onlyBytes.lines);
        assert.ok(onlyBytes.bytes > onlyLines.bytes);

        addBranchState("feat-lines", manyShort);
        addBranchState("feat-bytes", fewLong);
        const both = stableL1Size(store, paths, projectId);

        // Each branch view also lists the other branch, so the sums can be a little larger.
        assert.ok(both.lines >= onlyLines.lines);
        assert.ok(both.bytes >= onlyBytes.bytes);
        assert.equal(both.fits, true);
    });

    it("names the first branch that is over a limit, and does not fit", () => {
        addBranchState("feat-ok", "short");
        addBranchState(
            "feat-over",
            Array.from({ length: L1_MAX_LINES }, (_, i) => `l${i}`).join("\n"),
        );

        const size = stableL1Size(store, paths, projectId);

        assert.equal(size.fits, false);
        assert.equal(size.branch, "feat-over");
    });
});

describe("stableL1Grew", () => {
    // Limits of the memory home of these tests. A branch is named "main" unless a test says more.
    let LINES = 0;
    let BYTES = 0;
    beforeEach(() => {
        const limits = stableL1Size(store, paths, projectId);
        LINES = limits.maxLines;
        BYTES = limits.maxBytes;
    });
    const sized = (...branches: StableL1Branch[]): StableL1Size => {
        const lines = Math.max(...branches.map((entry) => entry.lines));
        const bytes = Math.max(...branches.map((entry) => entry.bytes));
        return {
            lines,
            bytes,
            branch: branches[0]?.branch ?? null,
            fits: lines <= LINES && bytes <= BYTES,
            maxLines: LINES,
            maxBytes: BYTES,
            branches,
        };
    };
    const size = (lines: number, bytes: number): StableL1Size =>
        sized({ branch: "main", lines, bytes });

    it("is false when the stable part fits", () => {
        assert.equal(stableL1Grew(size(10, 100), size(LINES, BYTES)), false);
        assert.equal(stableL1Grew(undefined, size(LINES, BYTES)), false);
    });

    it("is true when the lines are over the limit and grew", () => {
        assert.equal(stableL1Grew(size(LINES + 1, 100), size(LINES + 2, 100)), true);
        assert.equal(stableL1Grew(size(10, 100), size(LINES + 1, 100)), true);
    });

    it("is true when the bytes are over the limit and grew", () => {
        assert.equal(stableL1Grew(size(10, BYTES + 1), size(10, BYTES + 2)), true);
    });

    it("is false when a commit leaves an over-limit part the same or smaller", () => {
        assert.equal(stableL1Grew(size(LINES + 5, 100), size(LINES + 5, 100)), false);
        assert.equal(stableL1Grew(size(LINES + 5, 100), size(LINES + 3, 100)), false);
        assert.equal(stableL1Grew(size(10, BYTES + 5), size(10, BYTES + 5)), false);
    });

    it("is false when lines grow but only the bytes are over the limit", () => {
        assert.equal(stableL1Grew(size(10, BYTES + 5), size(20, BYTES + 5)), false);
    });

    it("is false when bytes grow but only the lines are over the limit", () => {
        assert.equal(stableL1Grew(size(LINES + 5, 100), size(LINES + 5, 900)), false);
    });

    it("is true when a limit that was fine goes over while the other stays over", () => {
        assert.equal(stableL1Grew(size(LINES + 5, 100), size(LINES + 5, BYTES + 1)), true);
    });

    it("is true for a first measurement that is already over a limit", () => {
        assert.equal(stableL1Grew(undefined, size(LINES + 1, 100)), true);
        assert.equal(stableL1Grew(undefined, size(10, BYTES + 1)), true);
    });
});

describe("grownStableBranch", () => {
    let LINES = 0;
    let BYTES = 0;
    beforeEach(() => {
        const limits = stableL1Size(store, paths, projectId);
        LINES = limits.maxLines;
        BYTES = limits.maxBytes;
    });
    const sized = (...branches: StableL1Branch[]): StableL1Size => ({
        lines: Math.max(...branches.map((entry) => entry.lines)),
        bytes: Math.max(...branches.map((entry) => entry.bytes)),
        branch: null,
        fits: false,
        maxLines: LINES,
        maxBytes: BYTES,
        branches,
    });

    it("returns a branch that grew over the limit although another branch is over by more", () => {
        const before = sized(
            { branch: "a", lines: LINES + 69, bytes: 100 },
            { branch: "b", lines: 27, bytes: 100 },
        );
        const after = sized(
            { branch: "a", lines: LINES + 69, bytes: 100 },
            { branch: "b", lines: LINES + 34, bytes: 100 },
        );

        const grown = grownStableBranch(before, after);

        assert.deepEqual(grown, { branch: "b", lines: LINES + 34, bytes: 100 });
        assert.equal(stableL1Grew(before, after), true);
    });

    it("does not return a branch that is over the limit but did not grow", () => {
        const both = sized(
            { branch: "a", lines: LINES + 69, bytes: 100 },
            { branch: "b", lines: 27, bytes: 100 },
        );

        assert.equal(grownStableBranch(both, both), null);
        assert.equal(stableL1Grew(both, both), false);
    });

    it("compares a branch that is new with nothing", () => {
        const before = sized({ branch: "a", lines: 10, bytes: 100 });
        const after = sized(
            { branch: "a", lines: 10, bytes: 100 },
            { branch: "fresh", lines: LINES + 1, bytes: 100 },
        );

        assert.equal(grownStableBranch(before, after)?.branch, "fresh");
        assert.equal(
            grownStableBranch(before, sized({ branch: "fresh", lines: 5, bytes: 5 })),
            null,
        );
    });

    it("ignores growth in lines while only the bytes are over, and the reverse", () => {
        const bytesOver = sized({ branch: "a", lines: 10, bytes: BYTES + 5 });
        const linesGrew = sized({ branch: "a", lines: 20, bytes: BYTES + 5 });
        const linesOver = sized({ branch: "a", lines: LINES + 5, bytes: 100 });
        const bytesGrew = sized({ branch: "a", lines: LINES + 5, bytes: 900 });

        assert.equal(grownStableBranch(bytesOver, linesGrew), null);
        assert.equal(grownStableBranch(linesOver, bytesGrew), null);
    });
});

describe("l1Reserve", () => {
    it("grows with a longer memory home, so the stable limits shrink", () => {
        const longPaths = memoryPaths(join(root, "x".repeat(300), "home"));

        const short = l1Reserve(paths, projectId);
        const long = l1Reserve(longPaths, projectId);
        const shortSize = stableL1Size(store, paths, projectId);
        const longSize = stableL1Size(store, longPaths, projectId);

        assert.ok(long.bytes > short.bytes);
        assert.ok(longSize.maxBytes < shortSize.maxBytes);
        assert.equal(longSize.maxBytes, L1_MAX_BYTES - long.bytes);
        assert.equal(longSize.maxLines, L1_MAX_LINES - long.lines);
    });
});

describe("assembleL1 under the budget", () => {
    function homeOfLength(length: number): string {
        let home = join(root, "h");
        while (home.length < length) {
            home = join(home, "x".repeat(Math.min(40, length - home.length - 1)));
        }
        return home.slice(0, length);
    }

    function addRecent(count: number, bigPaths: MemoryPaths): void {
        for (let i = 0; i < count; i++) {
            const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
            seedSession(store, {
                id,
                harness: "claude",
                projectId,
                cwd: repo,
                branch: "main",
                transcriptPath: transcriptFile(bigPaths, projectId, "claude", id),
                events: [{ role: "user", text: "hello" }],
            });
        }
    }

    /** Fill the project preferences until the stable part is just under the byte limit. */
    function fillStable(bigPaths: MemoryPaths): void {
        for (let n = 0; n < 500; n++) {
            const item = makeItem({
                projectId,
                kind: "preference",
                title: `Pref ${n}`,
                body: "y".repeat(400),
            });
            putItem(store, item);
            if (!stableL1Size(store, bigPaths, projectId).fits) {
                store.run("DELETE FROM items WHERE id = ?", item.id);
                return;
            }
        }
        assert.fail("the stable part never reached its limit");
    }

    it("keeps a full stable part and ten of eleven sessions inside the budget with a long home", () => {
        const bigPaths = memoryPaths(homeOfLength(435));
        fillStable(bigPaths);
        addRecent(11, bigPaths);

        const l1 = assembleL1(store, bigPaths, resolver, repo, { sessionId: "z".repeat(36) });

        assert.ok(l1.bytes <= L1_MAX_BYTES);
        assert.ok(l1.lines <= L1_MAX_LINES);
        assert.equal(l1.overBudget, false);
        assert.equal(l1.text.split("\n").filter((line) => line.startsWith("- claude ")).length, 10);
        assert.ok(l1.text.includes("- 1 more. Use transcript_search to find them."));
    });

    function recentLines(text: string): string[] {
        return text.split("\n").filter((line) => line.startsWith("- claude "));
    }

    /** Add small preferences until fewer than `shown` recent sessions are listed. */
    function squeezeUntilFewerThan(shown: number, bigPaths: MemoryPaths) {
        let l1 = assembleL1(store, bigPaths, resolver, repo);
        for (let n = 0; n < 400 && recentLines(l1.text).length >= shown; n++) {
            add({ kind: "preference", title: `Fill ${n}`, body: "q".repeat(8) });
            l1 = assembleL1(store, bigPaths, resolver, repo);
        }
        return l1;
    }

    it("cuts the recent list to what fits, counts the rest, and keeps stable part and guidance", () => {
        const bigPaths = memoryPaths(homeOfLength(435));
        fillStable(bigPaths);
        addRecent(11, bigPaths);

        const l1 = squeezeUntilFewerThan(10, bigPaths);

        const listed = recentLines(l1.text);
        const counted = l1.text.match(/^- (\d+) more\. Use transcript_search to find them\.$/mu);
        assert.ok(listed.length > 0 && listed.length < 10);
        assert.ok(counted);
        assert.equal(listed.length + Number(counted[1]), 11);
        assert.ok(l1.text.includes("## How to use this memory"));
        const stored = listItems(store, { kind: ["preference"], status: ["active"] }).length;
        assert.equal(l1.text.match(/^- (Pref|Fill) \d+/gmu)?.length, stored);
        assert.ok(l1.bytes <= L1_MAX_BYTES && l1.lines <= L1_MAX_LINES);
        assert.equal(l1.overBudget, false);
    });

    it("says `N sessions` when none fits and keeps the stable part and guidance whole", () => {
        addRecent(2, paths);

        const l1 = squeezeUntilFewerThan(1, paths);

        assert.equal(recentLines(l1.text).length, 0);
        assert.ok(l1.text.includes("- 2 sessions. Use transcript_search to find them."));
        assert.ok(l1.text.includes("## How to use this memory"));
        const stored = listItems(store, { kind: ["preference"], status: ["active"] }).length;
        assert.equal(l1.text.match(/^- Fill \d+/gmu)?.length, stored);
        assert.equal(l1.overBudget, false);
    });

    it("is over budget only when the stable part and the guidance alone are over it", () => {
        add({ kind: "preference", title: "Huge", body: "w".repeat(L1_MAX_BYTES) });
        addRecent(2, paths);

        const l1 = assembleL1(store, paths, resolver, repo);

        assert.equal(l1.overBudget, true);
        assert.ok(l1.text.includes("- Huge\n  www"));
        assert.ok(l1.text.includes("## How to use this memory"));
        assert.ok(!l1.text.includes("## Recent sessions not yet in memory"));
    });
});
