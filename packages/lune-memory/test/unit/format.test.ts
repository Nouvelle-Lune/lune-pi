import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Item } from "../../src/core/types.ts";
import { formatLocation, formatNote, formatSearchResult } from "../../src/integrations/format.ts";
import type { SearchHit, SearchResult } from "../../src/memory/search.ts";
import type { MemoryLocation } from "../../src/service.ts";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
        harness: "claude",
        sessionId: "s-1",
        eventKey: "ev-1",
        seq: 4,
        role: "assistant",
        toolName: null,
        time: "2026-01-01T00:00:00.000Z",
        title: "Fix the build",
        branch: null,
        excerpt: "the  needle\nline",
        excerptStart: 0,
        excerptEnd: 10,
        textLength: 10,
        untrusted: false,
        memoryDerived: false,
        active: true,
        before: [],
        after: [],
        transcriptPath: "/t/s-1.md",
        transcriptLine: 12,
        sourcePath: "/src/s-1.jsonl",
        sourceLine: 3,
        ...overrides,
    } as SearchHit;
}

describe("formatSearchResult", () => {
    it("says so when there are no hits", () => {
        const actual = formatSearchResult({
            query: "zzz",
            hits: [],
            limited: false,
        } as unknown as SearchResult);
        assert.equal(actual, "No transcript hits for: zzz");
    });

    it("gives the place to read, the source and a citation for each hit", () => {
        const actual = formatSearchResult({
            query: "needle",
            hits: [hit()],
            limited: false,
        } as unknown as SearchResult);
        assert.match(actual, /^1 transcript hit\(s\) for: needle\./u);
        assert.match(actual, />> 4 assistant: the needle line/u);
        assert.match(actual, /Read: \/t\/s-1\.md:12/u);
        assert.match(actual, /Source: \/src\/s-1\.jsonl:3/u);
        assert.match(actual, /Cite: harness=claude session=s-1 event=ev-1/u);
    });

    it("marks flags, truncation and a stopped search", () => {
        const actual = formatSearchResult({
            query: "q",
            hits: [
                hit({
                    untrusted: true,
                    active: false,
                    excerptStart: 5,
                    excerptEnd: 6,
                    textLength: 9,
                    toolName: "bash",
                }),
            ],
            limited: true,
        } as unknown as SearchResult);
        assert.match(actual, /\[untrusted, abandoned branch\]/u);
        assert.match(actual, /assistant bash/u);
        assert.match(actual, /: …the needle line…/u);
        assert.match(actual, /more hits can exist/u);
    });
});

describe("formatNote", () => {
    const base = {
        id: "n-1",
        title: "T",
        kind: "note",
        status: "provisional",
        trust: "inference",
        scope: "project",
        projectId: "p-1",
        branch: "main",
    } as Item;

    it("describes a project note with its branch and a global note", () => {
        assert.equal(
            formatNote(base, "Saved"),
            'Saved note n-1: "T" (note, provisional, project p-1, branch main, trust inference).',
        );
        const global = formatNote({ ...base, scope: "global", projectId: null } as Item, "Updated");
        assert.match(global, /\(note, provisional, global, trust inference\)/u);
    });
});

describe("formatLocation", () => {
    const location = {
        home: "/h",
        views: "/h/views",
        generation: null,
        projectId: null,
        projectName: null,
        branch: null,
        project: null,
        global: { root: "/g", index: "/g/index.md", notes: "/g/notes" },
        transcripts: "/h/transcripts/_unassigned",
    } as MemoryLocation;

    it("reports no project and ungenerated views", () => {
        const actual = formatLocation(location);
        assert.match(actual, /Project: none/u);
        assert.match(actual, /The views are not generated yet\./u);
    });

    it("lists the project folders when a project is known", () => {
        const actual = formatLocation({
            ...location,
            generation: "g1",
            projectId: "p-1",
            projectName: "Alpha",
            branch: "dev",
            project: {
                root: "/r",
                index: "/r/index.md",
                wiki: "/r/wiki",
                notes: "/r/notes",
                transcripts: "/r/t",
            },
        });
        assert.match(actual, /Project: Alpha \(p-1, branch dev\)/u);
        assert.match(actual, /Wiki: \/r\/wiki/u);
        assert.doesNotMatch(actual, /not generated/u);
    });
});
