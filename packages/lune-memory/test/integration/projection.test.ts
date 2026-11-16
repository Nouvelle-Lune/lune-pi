import assert from "node:assert/strict";
import {
    existsSync,
    lstatSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { memoryPaths, projectViewPaths, type MemoryPaths } from "../../src/core/paths.ts";
import type { Item } from "../../src/core/types.ts";
import {
    currentGeneration,
    itemFileName,
    projectItem,
    regenerateProjection,
} from "../../src/memory/projection.ts";
import { Store } from "../../src/store/db.ts";
import { putItem } from "../../src/store/rows.ts";
import { makeItem, seedSession } from "../harness/memory.ts";

const PROJECT = "p-abc12345";
const BASE = Date.parse("2026-02-01T00:00:00.000Z");

let root: string;
let paths: MemoryPaths;
let store: Store;
let tick: number;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lune-memory-test-")));
    paths = memoryPaths(join(root, "home"));
    store = Store.open(":memory:");
    store.run(
        "INSERT INTO projects(id, name, root, merged_into, created_at) VALUES (?, 'Demo App', '/demo', NULL, 'x')",
        PROJECT,
    );
    tick = 0;
});

afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
});

function regenerate(generations = 3) {
    return regenerateProjection(store, paths, { generations }, { now: () => BASE + ++tick * 1000 });
}

function add(overrides: Partial<Item>): Item {
    const item = makeItem({ projectId: PROJECT, ...overrides });
    putItem(store, item);
    return item;
}

function mode(path: string): number {
    return statSync(path).mode & 0o777;
}

describe("projection files", () => {
    it("writes the index, item pages, wiki pages and README of each scope", () => {
        const decision = add({ title: "Use WAL mode", body: "WAL is on. Readers never block." });
        const wiki = add({
            kind: "wiki",
            title: "Storage",
            body: "See [[Use WAL mode]] for details.",
        });
        const global = add({
            scope: "global",
            projectId: null,
            kind: "preference",
            title: "Be brief",
            body: "Short.",
        });

        const { dir } = regenerate();

        const view = (...parts: string[]) => join(dir, "projects", PROJECT, ...parts);
        const decisionPage = readFileSync(view("notes", `${itemFileName(decision)}.md`), "utf8");
        const wikiPage = readFileSync(view("wiki", `${itemFileName(wiki)}.md`), "utf8");
        assert.ok(decisionPage.includes("kind: decision"));
        assert.ok(decisionPage.includes("# Use WAL mode"));
        assert.ok(decisionPage.includes("Read-only view"));
        assert.ok(wikiPage.includes(`[[notes/${itemFileName(decision)}|Use WAL mode]]`));
        const index = readFileSync(view("index.md"), "utf8");
        assert.ok(index.includes("# Demo App"));
        assert.ok(index.includes("Use WAL mode"));
        assert.ok(readFileSync(join(dir, "global", "index.md"), "utf8").includes("Be brief"));
        assert.ok(existsSync(join(dir, "global", "notes", `${itemFileName(global)}.md`)));
        assert.ok(readFileSync(join(dir, "README.md"), "utf8").includes(PROJECT));
    });

    it("marks provisional notes and leaves retired items out", () => {
        const note = add({
            kind: "note",
            title: "Agent claim",
            status: "provisional",
            origin: "agent_note",
            trust: "inference",
        });
        const retired = add({ title: "Old news", status: "retired" });

        const { dir } = regenerate();

        const notes = readdirSync(join(dir, "projects", PROJECT, "notes"));
        assert.deepEqual(notes, [`${itemFileName(note)}.md`]);
        assert.ok(!notes.some((name) => name.includes(retired.id)));
        const page = readFileSync(join(dir, "projects", PROJECT, "notes", notes[0] ?? ""), "utf8");
        assert.ok(page.includes("status: provisional"));
        assert.ok(page.includes("has not reviewed yet"));
        const index = readFileSync(join(dir, "projects", PROJECT, "index.md"), "utf8");
        assert.ok(index.includes("## Agent notes not yet reviewed"));
        assert.ok(!index.includes("Old news"));
    });

    it("lists the event sources of an item with the transcript path and line", () => {
        const transcript = join(paths.transcripts, PROJECT, "pi", "s1.md");
        seedSession(store, {
            id: "s1",
            projectId: PROJECT,
            transcriptPath: transcript,
            events: [{ text: "x" }],
        });
        store.run("UPDATE events SET transcript_line = 12 WHERE session_id = 's1'");
        const item = add({
            sources: [{ kind: "event", harness: "pi", sessionId: "s1", eventKey: "k0" }],
        });

        const { dir } = regenerate();

        const page = readFileSync(
            join(dir, "projects", PROJECT, "notes", `${itemFileName(item)}.md`),
            "utf8",
        );
        assert.ok(page.includes(`${transcript}:12`));
    });

    it("links the project transcripts folder to the L4 folder", () => {
        const { dir } = regenerate();

        const link = join(dir, "projects", PROJECT, "transcripts");
        assert.ok(lstatSync(link).isSymbolicLink());
        assert.equal(readlinkSync(link), join(paths.transcripts, PROJECT));
    });
});

describe("generations", () => {
    it("points views at the newest generation through a symlink", () => {
        const first = regenerate();
        const second = regenerate();

        assert.ok(lstatSync(paths.views).isSymbolicLink());
        assert.equal(currentGeneration(paths), realpathSync(second.dir));
        assert.notEqual(first.generation, second.generation);
        assert.ok(existsSync(join(paths.views, "global", "index.md")));
        assert.equal(
            projectViewPaths(paths, PROJECT).index,
            join(paths.views, "projects", PROJECT, "index.md"),
        );
    });

    it("keeps the newest three generations and prunes older ones", () => {
        const names = Array.from({ length: 5 }, () => regenerate().generation);

        const kept = readdirSync(paths.generations).sort();

        assert.deepEqual(kept, names.slice(2).sort());
        assert.equal(basename(currentGeneration(paths) ?? ""), names[4]);
    });

    it("keeps the previous generation intact while a new one is current", () => {
        add({ title: "First", body: "One." });
        const first = regenerate();
        add({ title: "Second", body: "Two." });

        const second = regenerate();

        const firstNotes = readdirSync(join(first.dir, "projects", PROJECT, "notes"));
        const secondNotes = readdirSync(join(second.dir, "projects", PROJECT, "notes"));
        assert.equal(firstNotes.length, 1);
        assert.equal(secondNotes.length, 2);
    });

    it("honours a smaller generation setting", () => {
        for (let i = 0; i < 4; i++) regenerate(1);

        assert.equal(readdirSync(paths.generations).length, 1);
    });
});

describe("file permissions", () => {
    it("writes files with mode 0600 and folders with mode 0700", () => {
        const item = add({ title: "Private", body: "Text." });
        const { dir } = regenerate();

        const files = [
            join(dir, "README.md"),
            join(dir, "global", "index.md"),
            join(dir, "projects", PROJECT, "index.md"),
            join(dir, "projects", PROJECT, "notes", `${itemFileName(item)}.md`),
        ];
        const folders = [
            paths.generations,
            dir,
            join(dir, "global"),
            join(dir, "projects", PROJECT),
            join(dir, "projects", PROJECT, "notes"),
        ];

        for (const file of files) assert.equal(mode(file), 0o600, file);
        for (const folder of folders) assert.equal(mode(folder), 0o700, folder);
    });
});

describe("projectItem", () => {
    it("adds a new note to the current generation without a new generation", () => {
        regenerate();
        const before = readdirSync(paths.generations);
        const note = add({
            kind: "note",
            title: "Fresh note",
            body: "Just written.",
            status: "provisional",
            origin: "agent_note",
        });

        projectItem(store, paths, note, { generations: 3 });

        assert.deepEqual(readdirSync(paths.generations), before);
        const page = join(paths.views, "projects", PROJECT, "notes", `${itemFileName(note)}.md`);
        assert.ok(readFileSync(page, "utf8").includes("Just written."));
        assert.ok(
            readFileSync(join(paths.views, "projects", PROJECT, "index.md"), "utf8").includes(
                "Fresh note",
            ),
        );
        assert.equal(mode(page), 0o600);
    });

    it("removes the page of a retired note", () => {
        const note = add({
            kind: "note",
            title: "Gone soon",
            status: "provisional",
            origin: "agent_note",
        });
        regenerate();
        const page = join(paths.views, "projects", PROJECT, "notes", `${itemFileName(note)}.md`);
        assert.ok(existsSync(page));
        store.run("UPDATE items SET status = 'retired' WHERE id = ?", note.id);

        projectItem(store, paths, { ...note, status: "retired" }, { generations: 3 });

        assert.ok(!existsSync(page));
    });

    it("runs a full regeneration when there are no views yet", () => {
        const note = add({
            kind: "note",
            title: "First ever",
            status: "provisional",
            origin: "agent_note",
        });

        projectItem(store, paths, note, { generations: 3 });

        assert.ok(currentGeneration(paths));
        assert.ok(
            existsSync(join(paths.views, "projects", PROJECT, "notes", `${itemFileName(note)}.md`)),
        );
    });
});
