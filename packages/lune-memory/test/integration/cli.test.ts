import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";

import { pidAlive } from "../../src/core/util.ts";
import { runCli, sandbox, type CliRun, type TempSandbox } from "../harness/cli.ts";
import { Store } from "../../src/store/db.ts";
import { putItem } from "../../src/store/rows.ts";
import { createMemoryEnv, createRepo, makeItem } from "../harness/memory.ts";
import { startEndpoint } from "../harness/endpoint.ts";

function run(box: TempSandbox, argv: string[], stdin?: string): Promise<CliRun> {
    return runCli(argv, {
        env: box.env,
        cwd: box.root,
        ...(stdin === undefined ? {} : { stdin }),
    });
}

// Parsed CLI output has a different shape for each command.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(text: string): any {
    return JSON.parse(text);
}

describe("exit codes", () => {
    it("exits 0 for help and version", async (t) => {
        const box = sandbox(t);

        const help = await run(box, ["help"]);
        const version = await run(box, ["--version"]);

        assert.equal(help.code, 0);
        assert.match(help.stdout, /^lune-memory: shared memory/u);
        assert.equal(version.code, 0);
        assert.match(version.stdout, /^\d+\.\d+\.\d+/u);
    });

    it("exits 2 and prints usage on stderr when no command is given", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, []);

        assert.equal(actual.code, 2);
        assert.match(actual.stderr, /Setup/u);
    });

    const usageErrors: Array<[string, string[], RegExp]> = [
        ["an unknown command", ["frobnicate"], /Unknown command: frobnicate/u],
        ["an unknown flag", ["status", "--bogus"], /Unknown option: --bogus/u],
        ["a value flag without value", ["status", "--home"], /--home needs a value/u],
        ["a boolean flag with a value", ["status", "--json=1"], /takes no value/u],
        ["an unknown harness", ["l1", "--harness", "vim"], /Unknown harness: vim/u],
        ["a search without query", ["search"], /Missing query/u],
        ["a limit out of range", ["search", "x", "--limit", "99"], /--limit must be an integer/u],
        ["a bad run id", ["revert", "abc"], /Not a run id/u],
        ["a bad split kind", ["split", "nope", "x"], /Locator kind must be one of/u],
        ["an unknown config key", ["config", "get", "no.such.key"], /Unknown config key/u],
        ["an unknown config action", ["config", "wipe"], /Unknown config action/u],
        ["a config set without value", ["config", "set", "retentionDays"], /Usage: config set/u],
        ["a bad session label", ["dream", "nolabel"], /Not a harness:id label/u],
        ["a forget without session", ["forget", "pi"], /Give a session/u],
        ["an unknown daemon action", ["daemon", "frobnicate"], /Unknown daemon action/u],
        ["both hook flags", ["setup", "claude", "--install-hook", "--remove-hook"], /not both/u],
        ["a hook flag for Pi", ["setup", "pi", "--install-hook"], /Pi needs no hook/u],
        ["an unknown credential action", ["credential", "wipe"], /Unknown credential action/u],
    ];
    for (const [name, argv, message] of usageErrors) {
        it(`exits 2 for ${name}`, async (t) => {
            const box = sandbox(t);

            const actual = await run(box, argv);

            assert.equal(actual.code, 2);
            assert.match(actual.stderr, message);
            assert.match(actual.stderr, /Run "lune-memory help" for usage\./u);
        });
    }

    it("exits 1 for a runtime error", async (t) => {
        const box = sandbox(t);
        writeFileSync(box.paths.config, "{ not json");

        const actual = await run(box, ["config", "get"]);

        assert.equal(actual.code, 1);
        assert.match(actual.stderr, /^Error: Cannot read /u);
    });
});

describe("read commands", () => {
    it("print valid JSON with --json", async (t) => {
        const box = sandbox(t);
        const commands = [
            ["status"],
            ["runs"],
            ["sessions"],
            ["projects"],
            ["location", "--cwd", box.root],
            ["search", "anything", "--cwd", box.root],
            ["l1", "--cwd", box.root],
        ];
        for (const command of commands) {
            const actual = await run(box, [...command, "--json"]);

            assert.equal(actual.code, 0, `${command.join(" ")}: ${actual.stderr}`);
            assert.doesNotThrow(() => parse(actual.stdout), command.join(" "));
        }
    });

    it("search --all without a daemon reaches sessions of other projects", async (t) => {
        const env = await createMemoryEnv();
        t.after(() => env.cleanup());
        env.service.setConfig({
            autoStart: false,
            harnesses: { pi: { enabled: true, root: env.piRoot } },
        });
        const repoA = createRepo(env.folder("a"));
        const repoB = createRepo(env.folder("b"));
        const text = "shared quokka topic";
        env.writePiSession({ id: "sa", cwd: repoA, messages: [{ role: "user", text }] });
        env.writePiSession({ id: "sb", cwd: repoB, messages: [{ role: "user", text }] });
        env.writePiSession({
            id: "loose",
            cwd: env.folder("plain"),
            messages: [{ role: "user", text }],
        });
        env.importNow();
        const options = { env: { ...process.env }, cwd: repoA };

        const scoped = await runCli(["search", "quokka", "--json"], options);
        const everywhere = await runCli(["search", "quokka", "--all", "--json"], options);

        assert.equal(scoped.code, 0, scoped.stderr);
        assert.equal(everywhere.code, 0, everywhere.stderr);
        const sessionsOf = (text: string): string[] => {
            const result = parse(text) as { hits: Array<{ sessionId: string }> };
            return result.hits.map((hit) => hit.sessionId).sort();
        };
        assert.deepEqual(sessionsOf(scoped.stdout), ["sa"]);
        assert.deepEqual(sessionsOf(everywhere.stdout), ["loose", "sa", "sb"]);
    });

    it("prints empty lists as 'No ...'", async (t) => {
        const box = sandbox(t);

        const runs = await run(box, ["runs"]);
        const sessions = await run(box, ["sessions"]);
        const projects = await run(box, ["projects"]);

        assert.equal(runs.stdout, "No runs\n");
        assert.equal(sessions.stdout, "No sessions\n");
        assert.equal(projects.stdout, "No projects\n");
    });

    it("prints empty JSON lists for the same commands", async (t) => {
        const box = sandbox(t);

        const runs = await run(box, ["runs", "--json"]);
        const projects = await run(box, ["projects", "--json"]);

        assert.deepEqual(parse(runs.stdout), []);
        assert.deepEqual(parse(projects.stdout), []);
    });

    it("accepts --project _unassigned for sessions", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["sessions", "--project", "_unassigned", "--json"]);

        assert.equal(actual.code, 0);
        assert.deepEqual(parse(actual.stdout), []);
    });

    it("shows the home and that no daemon runs in the status text", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["status"]);

        assert.equal(actual.code, 0);
        assert.match(actual.stdout, new RegExp(`^Home: ${box.home}$`, "mu"));
        assert.match(actual.stdout, /^Daemon: not running$/mu);
    });

    it("uses --home over the environment", async (t) => {
        const box = sandbox(t);
        const other = join(box.root, "other-home");

        const actual = await run(box, ["status", "--home", other, "--json"]);

        assert.equal(parse(actual.stdout).home, other);
    });
});

describe("l1", () => {
    it("announces the session id only with --session", async (t) => {
        const box = sandbox(t);

        const plain = await run(box, ["l1", "--cwd", box.root]);
        const announced = await run(box, ["l1", "--cwd", box.root, "--session", "sess-42"]);

        assert.equal(plain.code, 0);
        assert.doesNotMatch(plain.stdout, /This session id is/u);
        assert.match(announced.stdout, /This session id is sess-42\./u);
    });
});

describe("hook", () => {
    it("prints the SessionStart context JSON for valid input", async (t) => {
        const box = sandbox(t);

        const actual = await run(
            box,
            ["hook", "--harness", "claude"],
            JSON.stringify({ cwd: box.root, session_id: "hook-session" }),
        );

        assert.equal(actual.code, 0);
        const output = parse(actual.stdout).hookSpecificOutput;
        assert.equal(output.hookEventName, "SessionStart");
        assert.match(output.additionalContext, /This session id is hook-session\./u);
    });

    it("writes the full context and a warning on stderr when the context is over its budget", async (t) => {
        const box = sandbox(t);
        const store = Store.open(box.paths.db);
        putItem(
            store,
            makeItem({
                scope: "global",
                projectId: null,
                kind: "preference",
                title: "Huge",
                body: Array.from({ length: 300 }, (_, i) => `rule ${i}`).join("\n"),
            }),
        );
        store.close();

        const actual = await run(
            box,
            ["hook", "--harness", "claude"],
            JSON.stringify({ cwd: box.root, session_id: "hook-session" }),
        );

        assert.equal(actual.code, 0);
        const context: string = parse(actual.stdout).hookSpecificOutput.additionalContext;
        assert.ok(context.includes("rule 0\n"));
        assert.ok(context.includes("rule 299"));
        assert.ok(context.includes("## How to use this memory"));
        assert.match(
            actual.stderr,
            /^lune-memory hook: the memory context is \d+ lines and \d+ bytes, which is over its budget/u,
        );
    });

    it("writes no budget warning when the context fits", async (t) => {
        const box = sandbox(t);

        const actual = await run(
            box,
            ["hook", "--harness", "claude"],
            JSON.stringify({ cwd: box.root, session_id: "hook-session" }),
        );

        assert.equal(actual.code, 0);
        assert.equal(actual.stderr, "");
    });

    it("exits 0 and reports on stderr for input that is not JSON", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["hook", "--harness", "claude"], "not json at all");

        assert.equal(actual.code, 0);
        assert.equal(actual.stdout, "");
        assert.match(actual.stderr, /^lune-memory hook: /u);
    });

    it("exits 0 for a bad harness and for a corrupt config", async (t) => {
        const box = sandbox(t);
        const badHarness = await run(box, ["hook", "--harness", "vim"], "{}");
        writeFileSync(box.paths.config, "{ not json");

        const corrupt = await run(box, ["hook", "--harness", "claude"], "{}");

        assert.equal(badHarness.code, 0);
        assert.equal(corrupt.code, 0);
        assert.match(corrupt.stderr, /lune-memory hook: /u);
    });

    it("exits 0 with empty input", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["hook", "--harness", "codex"], "");

        assert.equal(actual.code, 0);
    });
});

describe("projects", () => {
    it("registers, lists, renames and merges projects", async (t) => {
        const box = sandbox(t);
        const one = join(box.root, "one");
        const two = join(box.root, "two");
        mkdirSync(one);
        mkdirSync(two);

        const first = parse((await run(box, ["register", one, "--name", "One", "--json"])).stdout);
        const second = parse((await run(box, ["register", two, "--name", "Two", "--json"])).stdout);
        const renamed = await run(box, ["rename", first.id, "First", "Project"]);
        const listed = await run(box, ["projects"]);
        const merged = await run(box, ["merge", second.id, first.id]);
        const after = parse((await run(box, ["projects", "--json"])).stdout);

        assert.equal(renamed.stdout, `${first.id} First Project\n`);
        assert.match(listed.stdout, new RegExp(`^${second.id} Two$`, "mu"));
        assert.equal(merged.stdout, `Merged ${second.id} into ${first.id}\n`);
        assert.deepEqual(
            after.map((project: { id: string }) => project.id),
            [first.id],
        );
    });
});

describe("config", () => {
    it("parses JSON values for config set and stores other text as a string", async (t) => {
        const box = sandbox(t);

        const number = await run(box, ["config", "set", "retentionDays", "30"]);
        const bool = await run(box, ["config", "set", "dreaming.enabled", "false"]);
        const text = await run(box, ["config", "set", "dreaming.model", "anthropic/claude-test"]);

        assert.equal(number.stdout, "retentionDays = 30\n");
        assert.equal(bool.stdout, "dreaming.enabled = false\n");
        assert.equal(text.stdout, 'dreaming.model = "anthropic/claude-test"\n');
        const saved = parse(readFileSync(box.paths.config, "utf8"));
        assert.equal(saved.retentionDays, 30);
        assert.equal(saved.dreaming.enabled, false);
        assert.equal(saved.dreaming.model, "anthropic/claude-test");
    });

    it("gets one key as raw text for strings and JSON otherwise", async (t) => {
        const box = sandbox(t);
        await run(box, ["config", "set", "dreaming.model", "anthropic/claude-test"]);

        const model = await run(box, ["config", "get", "dreaming.model"]);
        const generations = await run(box, ["config", "get", "generations"]);
        const all = await run(box, ["config", "get"]);

        assert.equal(model.stdout, "anthropic/claude-test\n");
        assert.equal(generations.stdout, "3\n");
        assert.equal(parse(all.stdout).generations, 3);
    });

    it("warns when the service normalizes a value", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["config", "set", "importSeconds", "1"]);

        assert.equal(actual.code, 0);
        assert.match(actual.stderr, /Warning: the value was normalized to 60/u);
        assert.equal(actual.stdout, "importSeconds = 60\n");
    });
});

describe("credential", () => {
    it("never prints a stored key in the text or JSON list", async (t) => {
        const box = sandbox(t);
        const secret = "test-key-not-real";

        const saved = await run(box, ["credential", "set", "anthropic"], `${secret}\n`);
        const text = await run(box, ["credential", "list"]);
        const asJson = await run(box, ["credential", "list", "--json"]);

        assert.equal(saved.code, 0, saved.stderr);
        assert.equal(saved.stdout, "Saved the key for anthropic\n");
        assert.equal(text.code, 0);
        assert.match(text.stdout, /^anthropic: configured/mu);
        assert.ok(!text.stdout.includes(secret) && !text.stderr.includes(secret));
        assert.ok(!asJson.stdout.includes(secret) && !asJson.stderr.includes(secret));
    });

    it("removes a key and rejects an empty key or a missing provider", async (t) => {
        const box = sandbox(t);
        await run(box, ["credential", "set", "anthropic"], "test-key-not-real\n");

        const removed = await run(box, ["credential", "remove", "anthropic"]);
        const empty = await run(box, ["credential", "set", "anthropic"], "\n");
        const missing = await run(box, ["credential", "set"]);

        assert.equal(removed.stdout, "Removed the key for anthropic\n");
        assert.equal(empty.code, 2);
        assert.match(empty.stderr, /The key is empty/u);
        assert.equal(missing.code, 2);
        assert.match(missing.stderr, /Missing provider/u);
    });

    it("exits 1 for an unknown provider", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["credential", "set", "no-such-provider"], "k\n");

        assert.equal(actual.code, 1);
        assert.match(actual.stderr, /Unknown provider/u);
    });
});

describe("setup", () => {
    it("lists the harnesses and installs and removes the hook in the temp config dir", async (t) => {
        const box = sandbox(t);

        const before = await run(box, ["setup"]);
        const install = await run(box, ["setup", "claude", "--install-hook", "--root", box.root]);
        const after = await run(box, ["setup"]);
        const remove = await run(box, ["setup", "claude", "--remove-hook"]);

        assert.equal(before.code, 0);
        assert.match(before.stdout, /^claude: off, .*, no hook$/mu);
        assert.match(before.stdout, /^pi: off, /mu);
        assert.equal(install.code, 0, install.stderr);
        assert.match(install.stdout, /^claude: enabled, /mu);
        assert.ok(
            install.stdout.includes(`Hook installed in ${join(box.claudeDir, "settings.json")}`),
        );
        assert.match(after.stdout, /^claude: enabled, .*, hook installed$/mu);
        assert.match(install.stdout, /^Sandbox: .*\n.*permissions\.allow.*Read\(\/\//mu);
        assert.match(remove.stdout, /^Removed 1 hook\(s\) from /mu);
    });

    it("turns the Codex hooks feature on in the temp Codex home", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["setup", "codex", "--install-hook"]);

        assert.equal(actual.code, 0, actual.stderr);
        assert.match(readFileSync(join(box.codexDir, "config.toml"), "utf8"), /hooks = true/u);
        assert.match(actual.stdout, /^Sandbox: /mu);
    });

    it("prints the Pi install command and the disabled state", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["setup", "pi", "--disable"]);

        assert.match(actual.stdout, /^pi: off, /mu);
        assert.match(actual.stdout, /^Install the Pi extension: pi install /mu);
    });
});

describe("daemon use", () => {
    it("admin commands do not start a daemon even when auto start is on", async (t) => {
        const box = sandbox(t, { autoStart: true });
        t.after(() => {
            // Safety net: never leave a daemon behind if the code under test started one.
            try {
                const info = parse(readFileSync(box.paths.daemon, "utf8"));
                if (pidAlive(info.pid) && info.pid !== process.pid)
                    process.kill(info.pid, "SIGKILL");
            } catch {
                // No daemon.json: nothing started.
            }
        });

        const status = await run(box, ["status", "--json"]);
        const runs = await run(box, ["runs"]);
        const projects = await run(box, ["projects"]);

        assert.equal(status.code, 0);
        assert.equal(runs.code, 0);
        assert.equal(projects.code, 0);
        assert.equal(existsSync(box.paths.daemon), false);
        assert.equal(existsSync(box.paths.logs), false, "no daemon log means no spawn attempt");
    });

    it("admin commands use a running daemon", async (t) => {
        const box = sandbox(t);
        const seen: string[] = [];
        const server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify([]));
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        const port = (server.address() as AddressInfo).port;
        writeFileSync(
            box.paths.daemon,
            JSON.stringify({
                pid: process.pid,
                port,
                token: "test-token-not-real",
                url: `http://127.0.0.1:${port}`,
            }),
        );

        const actual = await run(box, ["runs", "--limit", "3"]);

        assert.equal(actual.stdout, "No runs\n");
        assert.deepEqual(seen, ["GET /api/runs?limit=3 Bearer test-token-not-real"]);
    });

    it("daemon status exits 1 when no daemon runs, and stop exits 0", async (t) => {
        const box = sandbox(t);

        const status = await run(box, ["daemon", "status"]);
        const stop = await run(box, ["daemon", "stop"]);

        assert.equal(status.code, 1);
        assert.equal(status.stdout, "The daemon does not run\n");
        assert.equal(stop.code, 0);
        assert.equal(stop.stdout, "The daemon does not run\n");
    });
});

describe("other commands", () => {
    it("import with every harness off scans nothing and exits 0", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["import"]);

        assert.equal(actual.code, 0, actual.stderr);
        assert.match(actual.stdout, /^Scanned 0, imported 0,/u);
    });

    it("regenerate prints the new generation", async (t) => {
        const box = sandbox(t);

        const actual = await run(box, ["regenerate"]);

        assert.equal(actual.code, 0, actual.stderr);
        assert.match(actual.stdout, /^Generation /u);
    });
});

describe("provider", () => {
    const KEY = "test-key-not-real";

    function modelsEndpoint(models: string[]) {
        return startEndpoint((request) =>
            request.url === "/v1/models"
                ? { json: { data: models.map((id) => ({ id })) } }
                : { status: 404, json: { error: `unexpected ${request.url}` } },
        );
    }

    it("adds a provider with a key from stdin and no scan, and lists it", async (t) => {
        const endpoint = await modelsEndpoint([]);
        t.after(() => endpoint.close());
        const box = sandbox(t);
        const baseUrl = `${endpoint.url}/v1`;

        const added = await run(
            box,
            [
                "provider",
                "add",
                "acme",
                "--api",
                "openai-completions",
                "--url",
                `${baseUrl}/`,
                "--name",
                "Acme",
                "--key",
                "--no-scan",
            ],
            `${KEY}\n`,
        );
        assert.equal(added.code, 0, added.stderr);
        assert.equal(added.stdout, "Added acme\n");
        assert.deepEqual(endpoint.requests, []);

        const modelsText = readFileSync(box.paths.models, "utf8");
        assert.ok(!modelsText.includes(KEY), "the key stays out of models.json");
        assert.deepEqual(JSON.parse(modelsText).providers.acme, {
            name: "Acme",
            baseUrl,
            api: "openai-completions",
        });
        assert.ok(readFileSync(box.paths.credentials, "utf8").includes(KEY));

        const text = await run(box, ["provider", "list"]);
        assert.equal(text.code, 0, text.stderr);
        assert.equal(text.stdout, `acme: openai-completions ${baseUrl}, 0 models, key set\n`);

        const asJson = await run(box, ["provider", "list", "--json"]);
        assert.equal(asJson.code, 0, asJson.stderr);
        const parsed = parse(asJson.stdout);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].id, "acme");
        assert.equal(parsed[0].custom, true);
        for (const output of [added, text, asJson]) {
            assert.ok(!output.stdout.includes(KEY) && !output.stderr.includes(KEY));
        }
    });

    it("scans a provider and removes it with its key", async (t) => {
        const endpoint = await modelsEndpoint(["acme-1", "acme-2"]);
        t.after(() => endpoint.close());
        const box = sandbox(t);
        const baseUrl = `${endpoint.url}/v1`;
        const add = await run(
            box,
            [
                "provider",
                "add",
                "acme",
                "--api",
                "openai-completions",
                "--url",
                baseUrl,
                "--key",
                "--no-scan",
            ],
            `${KEY}\n`,
        );
        assert.equal(add.code, 0, add.stderr);

        const scanned = await run(box, ["provider", "scan", "acme"]);
        assert.equal(scanned.code, 0, scanned.stderr);
        assert.equal(scanned.stdout, "acme: 2 models\n");
        const models = JSON.parse(readFileSync(box.paths.models, "utf8"));
        assert.deepEqual(
            models.providers.acme.models.map((model: { id: string }) => model.id),
            ["acme-1", "acme-2"],
        );

        const listed = await run(box, ["provider", "list"]);
        assert.equal(listed.stdout, `acme: openai-completions ${baseUrl}, 2 models, key set\n`);

        const removed = await run(box, ["provider", "remove", "acme"]);
        assert.equal(removed.code, 0, removed.stderr);
        assert.equal(removed.stdout, "Removed acme\n");
        assert.ok(!readFileSync(box.paths.credentials, "utf8").includes(KEY));
        const empty = await run(box, ["provider", "list"]);
        assert.equal(empty.stdout, "No custom providers\n");
    });

    it("rejects an add with an unknown protocol, a missing URL or an empty key", async (t) => {
        const box = sandbox(t);

        const badProtocol = await run(box, [
            "provider",
            "add",
            "acme",
            "--api",
            "grpc",
            "--url",
            "http://127.0.0.1:1/v1",
            "--no-scan",
        ]);
        assert.equal(badProtocol.code, 1);
        assert.match(badProtocol.stderr, /^Error: api must be one of/u);

        const missingUrl = await run(box, [
            "provider",
            "add",
            "acme",
            "--api",
            "openai-completions",
        ]);
        assert.equal(missingUrl.code, 2);
        assert.match(missingUrl.stderr, /provider add needs --api and --url/u);

        const emptyKey = await run(
            box,
            [
                "provider",
                "add",
                "acme",
                "--api",
                "openai-completions",
                "--url",
                "http://127.0.0.1:1/v1",
                "--key",
            ],
            "\n",
        );
        assert.equal(emptyKey.code, 2);
        assert.match(emptyKey.stderr, /The key is empty/u);
    });
});
