import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    defaultConfig,
    loadConfig,
    memoryHome,
    normalizeConfig,
    parseModelRef,
    saveConfig,
} from "../../src/core/config.ts";
import { memoryPaths, transcriptFile } from "../../src/core/paths.ts";
import { firstSentence, lineCount, safeSegment, slugify } from "../../src/core/util.ts";
import { makeTempDir, removeDir } from "../harness/ingest.ts";

const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "LUNE_MEMORY_HOME"] as const;

describe("config", () => {
    let dir: string;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        dir = makeTempDir();
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        removeDir(dir);
    });

    describe("defaultConfig", () => {
        it("uses the home defaults when no env override is set", () => {
            const actual = defaultConfig("/home/u", {});
            assert.equal(actual.harnesses.pi.root, join("/home/u", ".pi", "agent", "sessions"));
            assert.equal(actual.harnesses.claude.root, join("/home/u", ".claude", "projects"));
            assert.equal(actual.harnesses.codex.root, join("/home/u", ".codex", "sessions"));
            assert.equal(actual.harnesses.claude.enabled, false);
        });

        it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
            const actual = defaultConfig("/home/u", {
                CLAUDE_CONFIG_DIR: "/cfg/claude",
                CODEX_HOME: "/cfg/codex",
            });
            assert.equal(actual.harnesses.claude.root, join("/cfg/claude", "projects"));
            assert.equal(actual.harnesses.codex.root, join("/cfg/codex", "sessions"));
        });

        it("ignores blank overrides", () => {
            const actual = defaultConfig("/home/u", { CLAUDE_CONFIG_DIR: "  ", CODEX_HOME: "" });
            assert.equal(actual.harnesses.claude.root, join("/home/u", ".claude", "projects"));
            assert.equal(actual.harnesses.codex.root, join("/home/u", ".codex", "sessions"));
        });
    });

    describe("normalizeConfig", () => {
        it("returns the defaults for input that is not an object", () => {
            const expected = defaultConfig(dir);
            assert.deepEqual(normalizeConfig("nope", dir), expected);
            assert.deepEqual(normalizeConfig(null, dir), expected);
            assert.deepEqual(normalizeConfig([1], dir), expected);
        });

        it("resets invalid values to the defaults and keeps valid ones", () => {
            const base = defaultConfig(dir);
            const actual = normalizeConfig(
                {
                    importSeconds: 1,
                    autoStart: "yes",
                    retentionDays: -5,
                    generations: 99,
                    dreaming: {
                        thinking: "bogus",
                        model: "no-slash",
                        concurrency: 99,
                        maxAttempts: 0,
                        idleHours: "6",
                        historyDays: 0,
                        maxRetries: 4.7,
                    },
                    harnesses: { claude: { enabled: true, root: "   " }, pi: { enabled: "x" } },
                },
                dir,
            );
            assert.equal(actual.importSeconds, base.importSeconds);
            assert.equal(actual.autoStart, base.autoStart);
            assert.equal(actual.retentionDays, base.retentionDays);
            assert.equal(actual.generations, base.generations);
            assert.equal(actual.dreaming.thinking, base.dreaming.thinking);
            assert.equal(actual.dreaming.model, null);
            assert.equal(actual.dreaming.concurrency, base.dreaming.concurrency);
            assert.equal(actual.dreaming.maxAttempts, base.dreaming.maxAttempts);
            assert.equal(actual.dreaming.idleHours, base.dreaming.idleHours);
            // 0 is a valid history limit and means no limit.
            assert.equal(actual.dreaming.historyDays, 0);
            assert.equal(actual.dreaming.maxRetries, 4);
            assert.equal(actual.harnesses.claude.enabled, true);
            assert.equal(actual.harnesses.claude.root, base.harnesses.claude.root);
            assert.equal(actual.harnesses.pi.enabled, false);
        });

        it("expands ~ in a harness root with the given home", () => {
            const actual = normalizeConfig({ harnesses: { codex: { root: "~/rollouts" } } }, dir);
            assert.equal(actual.harnesses.codex.root, join(dir, "rollouts"));
        });
    });

    describe("loadConfig and saveConfig", () => {
        it("returns the defaults when the file does not exist", () => {
            process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-cfg");
            const actual = loadConfig(join(dir, "missing.json"));
            assert.equal(actual.harnesses.claude.root, join(dir, "claude-cfg", "projects"));
        });

        it("round trips a saved config and writes it with mode 0600", () => {
            const path = join(dir, "nested", "config.json");
            const expected = defaultConfig(dir);
            expected.harnesses.pi = { enabled: true, root: join(dir, "pi") };
            expected.dreaming.model = "anthropic/claude-sonnet-4-5";
            expected.dreaming.historyDays = 0;
            saveConfig(path, expected);
            assert.equal(statSync(path).mode & 0o777, 0o600);
            const actual = loadConfig(path);
            assert.deepEqual(actual.harnesses.pi, expected.harnesses.pi);
            assert.equal(actual.dreaming.model, expected.dreaming.model);
            assert.equal(actual.dreaming.historyDays, 0);
        });

        it("throws a readable error for invalid JSON", () => {
            const path = join(dir, "config.json");
            writeFileSync(path, "{ not json");
            assert.throws(() => loadConfig(path), /Cannot read/u);
        });
    });

    it("memoryHome prefers LUNE_MEMORY_HOME", () => {
        assert.equal(memoryHome({ LUNE_MEMORY_HOME: " /x/mem " }), "/x/mem");
        assert.ok(memoryHome({}).endsWith(".lune-memory"));
    });

    it("parseModelRef splits on the first slash only", () => {
        assert.deepEqual(parseModelRef("openrouter/meta/llama"), {
            provider: "openrouter",
            id: "meta/llama",
        });
        assert.equal(parseModelRef("/x"), null);
        assert.equal(parseModelRef("x/"), null);
        assert.equal(parseModelRef("plain"), null);
    });
});

describe("paths and util helpers", () => {
    it("builds transcript paths with safe segments and an unassigned bucket", () => {
        const paths = memoryPaths("/m");
        assert.equal(paths.db, join("/m", "memory.db"));
        assert.equal(
            transcriptFile(paths, null, "pi", "a/b"),
            join("/m", "transcripts", "_unassigned", "pi", "a_b.md"),
        );
    });

    it("safeSegment removes separators and leading dots", () => {
        assert.equal(safeSegment("../etc/passwd"), "__etc_passwd");
        assert.equal(safeSegment(""), "_");
    });

    it("slugify, firstSentence and lineCount behave on edge input", () => {
        assert.equal(slugify("Hello, World!"), "hello-world");
        assert.equal(slugify("!!!"), "item");
        assert.equal(firstSentence("One. Two."), "One.");
        assert.equal(lineCount("a\nb\n"), 2);
        assert.equal(lineCount(""), 0);
    });

    it("creates parent folders for the saved config", () => {
        // Guards the folder mode that writeFileAtomic promises.
        const dir = makeTempDir();
        try {
            mkdirSync(join(dir, "x"));
            const path = join(dir, "x", "y", "config.json");
            saveConfig(path, defaultConfig(dir));
            assert.equal(statSync(join(dir, "x", "y")).mode & 0o777, 0o700);
        } finally {
            removeDir(dir);
        }
    });
});
