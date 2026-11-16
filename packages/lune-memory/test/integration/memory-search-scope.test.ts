import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createMemoryEnv, createRepo, type MemoryEnv } from "../harness/memory.ts";

let env: MemoryEnv;

beforeEach(async () => {
    env = await createMemoryEnv();
});

afterEach(() => {
    env.cleanup();
});

function session(id: string, cwd: string): void {
    env.writePiSession({ id, cwd, messages: [{ role: "user", text: "shared quokka topic" }] });
}

describe("service search scope and session listing", () => {
    it("searches the project of the cwd by default and every project with a null project", () => {
        const repoA = createRepo(env.folder("a"));
        const repoB = createRepo(env.folder("b"));
        session("sa", repoA);
        session("sb", repoB);
        env.importNow();

        const scoped = env.service.search({ query: "quokka", cwd: repoA });
        const everywhere = env.service.search({ query: "quokka", cwd: repoA, projectId: null });

        assert.deepEqual(
            scoped.hits.map((hit) => hit.sessionId),
            ["sa"],
        );
        assert.deepEqual(everywhere.hits.map((hit) => hit.sessionId).sort(), ["sa", "sb"]);
    });

    it("searches every session from a cwd outside every project", () => {
        const repo = createRepo(env.folder("a"));
        const outside = env.folder("outside");
        session("in-project", repo);
        session("loose", env.folder("plain"));
        env.importNow();

        const actual = env.service.search({ query: "quokka", cwd: outside });

        assert.deepEqual(actual.hits.map((hit) => hit.sessionId).sort(), ["in-project", "loose"]);
    });

    it("selects sessions outside any project with a null project id", () => {
        const repo = createRepo(env.folder("a"));
        session("in-project", repo);
        session("loose", env.folder("plain"));
        env.importNow();

        const unassigned = env.service.sessions({ projectId: null }).map((s) => s.id);
        const all = env.service
            .sessions()
            .map((s) => s.id)
            .sort();

        assert.deepEqual(unassigned, ["loose"]);
        assert.deepEqual(all, ["in-project", "loose"]);
    });
});
