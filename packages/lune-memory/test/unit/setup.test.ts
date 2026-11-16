import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
    enableCodexHooks,
    hookInstalled,
    installHook,
    mcpAddCommand,
    piInstallCommand,
    removeHook,
    sandboxHint,
} from "../../src/integrations/setup.ts";
import { sandbox, type TempSandbox } from "../harness/cli.ts";

const COMMAND = "lune-memory hook --harness claude";
const OTHER_HOOK = { type: "command", command: "other-tool notify --harness x", timeout: 5 };
const NOW = new Date("2026-03-04T05:06:07.890Z");

function options(box: TempSandbox) {
    return {
        env: { CLAUDE_CONFIG_DIR: box.claudeDir, CODEX_HOME: box.codexDir },
        userHome: box.root,
        now: NOW,
    };
}

// Settings files are free-form JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function readJson(file: string): Json {
    return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function sessionStart(
    file: string,
): Array<{ matcher?: string; hooks: Array<{ command: string }> }> {
    return readJson(file)["hooks"].SessionStart;
}

describe("installHook for Claude Code", () => {
    it("creates settings.json with one SessionStart hook and no backup", (t) => {
        const box = sandbox(t);

        const result = installHook("claude", { ...options(box), command: COMMAND });

        assert.equal(result.hooks.file, join(box.claudeDir, "settings.json"));
        assert.equal(result.hooks.changed, true);
        assert.equal(result.hooks.backup, null);
        assert.equal(result.feature, undefined);
        const groups = sessionStart(result.hooks.file);
        assert.equal(groups.length, 1);
        assert.equal(groups[0]?.matcher, "^(startup|resume|clear|compact|fork)$");
        assert.equal(groups[0]?.hooks[0]?.command, COMMAND);
    });

    it("keeps other settings and hooks, writes a timestamped backup and keeps the file mode", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        const original = `${JSON.stringify(
            {
                model: "x",
                hooks: {
                    SessionStart: [{ hooks: [OTHER_HOOK] }],
                    Stop: [{ hooks: [OTHER_HOOK] }],
                },
            },
            null,
            2,
        )}\n`;
        writeFileSync(file, original);
        chmodSync(file, 0o640);

        const result = installHook("claude", { ...options(box), command: COMMAND });

        assert.equal(result.hooks.backup, `${file}.lune-memory-backup.20260304T050607Z`);
        assert.equal(readFileSync(result.hooks.backup ?? "", "utf8"), original);
        const settings = readJson(file);
        assert.equal(settings["model"], "x");
        assert.deepEqual(settings["hooks"].Stop, [{ hooks: [OTHER_HOOK] }]);
        const groups = sessionStart(file);
        assert.equal(groups.length, 2);
        assert.deepEqual(groups[0], { hooks: [OTHER_HOOK] });
        assert.equal(statSync(file).mode & 0o777, 0o640);
        const leftovers = readdirSync(box.claudeDir).filter((name) => name.includes(".tmp-"));
        assert.deepEqual(leftovers, []);
    });

    it("is idempotent: a second install changes nothing and writes no backup", (t) => {
        const box = sandbox(t);
        installHook("claude", { ...options(box), command: COMMAND });
        const file = join(box.claudeDir, "settings.json");
        const before = readFileSync(file, "utf8");

        const again = installHook("claude", { ...options(box), command: COMMAND });

        assert.equal(again.hooks.changed, false);
        assert.equal(again.hooks.backup, null);
        assert.equal(readFileSync(file, "utf8"), before);
        assert.deepEqual(
            readdirSync(box.claudeDir).filter((name) => name.includes("backup")),
            [],
        );
    });

    it("replaces its own hook when the command changes", (t) => {
        const box = sandbox(t);
        installHook("claude", { ...options(box), command: COMMAND });

        installHook("claude", {
            ...options(box),
            command: "lune-memory --home /x hook --harness claude",
        });

        const groups = sessionStart(join(box.claudeDir, "settings.json"));
        assert.equal(groups.length, 1);
        assert.equal(groups[0]?.hooks[0]?.command, "lune-memory --home /x hook --harness claude");
    });

    it("never overwrites invalid JSON: it throws and leaves the file unchanged", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        writeFileSync(file, "{ not json");

        assert.throws(
            () => installHook("claude", { ...options(box), command: COMMAND }),
            /not valid JSON/u,
        );

        assert.equal(readFileSync(file, "utf8"), "{ not json");
        assert.deepEqual(readdirSync(box.claudeDir), ["settings.json"]);
    });

    it("rejects settings of the wrong shape and leaves the file unchanged", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        for (const text of ["[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
            writeFileSync(file, text);

            assert.throws(() => installHook("claude", { ...options(box), command: COMMAND }));

            assert.equal(readFileSync(file, "utf8"), text);
        }
    });
});

describe("installHook for Codex", () => {
    it("writes hooks.json and turns the hooks feature on in config.toml", (t) => {
        const box = sandbox(t);

        const result = installHook("codex", {
            ...options(box),
            command: "lune-memory hook --harness codex",
        });

        assert.equal(result.hooks.file, join(box.codexDir, "hooks.json"));
        assert.equal(sessionStart(result.hooks.file)[0]?.matcher, "startup|resume|clear|compact");
        assert.equal(result.feature?.file, join(box.codexDir, "config.toml"));
        assert.equal(result.feature?.changed, true);
        assert.equal(
            readFileSync(join(box.codexDir, "config.toml"), "utf8"),
            "[features]\nhooks = true\n",
        );
    });

    it("keeps other config text, backs it up, and never turns the feature off", (t) => {
        const box = sandbox(t);
        const config = join(box.codexDir, "config.toml");
        writeFileSync(config, 'model = "x"\n\n[features]\nother = true\nhooks = false\n');

        const first = installHook("codex", {
            ...options(box),
            command: "lune-memory hook --harness codex",
        });
        const removed = removeHook("codex", options(box));

        assert.equal(
            readFileSync(config, "utf8"),
            'model = "x"\n\n[features]\nother = true\nhooks = true\n',
        );
        assert.ok(first.feature?.backup);
        assert.equal(
            readFileSync(first.feature?.backup ?? "", "utf8"),
            'model = "x"\n\n[features]\nother = true\nhooks = false\n',
        );
        assert.equal(removed.removed, 1);
        assert.match(readFileSync(config, "utf8"), /hooks = true/u);
    });

    it("leaves config.toml untouched when the feature is already on", (t) => {
        const box = sandbox(t);
        writeFileSync(join(box.codexDir, "config.toml"), "[features]\nhooks = true\n");

        const result = installHook("codex", {
            ...options(box),
            command: "lune-memory hook --harness codex",
        });

        assert.equal(result.feature?.changed, false);
        assert.equal(result.feature?.backup, null);
    });
});

describe("enableCodexHooks", () => {
    const cases: Array<[string, string, string, boolean]> = [
        ["empty text", "", "[features]\nhooks = true\n", true],
        ["no features table", "a = 1\n", "a = 1\n\n[features]\nhooks = true\n", true],
        [
            "features table without hooks",
            "[features]\nx = 1\n[other]\ny = 2\n",
            "[features]\nhooks = true\nx = 1\n[other]\ny = 2\n",
            true,
        ],
        [
            "hooks off in the table",
            "[features]\nhooks = false\n",
            "[features]\nhooks = true\n",
            true,
        ],
        ["dotted key off", "features.hooks = false\n", "features.hooks = true\n", true],
        ["dotted key on", "features.hooks = true\n", "features.hooks = true\n", false],
        [
            "hooks in another table only",
            "[tools]\nhooks = false\n",
            "[tools]\nhooks = false\n\n[features]\nhooks = true\n",
            true,
        ],
    ];
    for (const [name, input, expected, changed] of cases) {
        it(`handles ${name}`, () => {
            const actual = enableCodexHooks(input);

            assert.equal(actual.text, expected);
            assert.equal(actual.changed, changed);
        });
    }
});

describe("removeHook", () => {
    it("removes only its own entries and backs up the file", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        writeFileSync(
            file,
            JSON.stringify({
                theme: "dark",
                hooks: {
                    SessionStart: [
                        { hooks: [OTHER_HOOK, { type: "command", command: COMMAND }] },
                        { matcher: "x", hooks: [{ type: "command", command: COMMAND }] },
                    ],
                },
            }),
        );

        const result = removeHook("claude", options(box));

        assert.equal(result.removed, 2);
        assert.equal(result.changed, true);
        assert.ok(result.backup);
        const settings = readJson(file);
        assert.equal(settings["theme"], "dark");
        assert.deepEqual(settings["hooks"].SessionStart, [{ hooks: [OTHER_HOOK] }]);
    });

    it("drops empty hook tables and keeps other settings", (t) => {
        const box = sandbox(t);
        installHook("claude", { ...options(box), command: COMMAND });
        const file = join(box.claudeDir, "settings.json");
        writeFileSync(file, JSON.stringify({ ...readJson(file), theme: "dark" }));

        removeHook("claude", options(box));

        assert.deepEqual(readJson(file), { theme: "dark" });
    });

    it("does nothing when the file is missing or holds no memory hook", (t) => {
        const box = sandbox(t);
        const missing = removeHook("claude", options(box));
        const file = join(box.claudeDir, "settings.json");
        const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [OTHER_HOOK] }] } });
        writeFileSync(file, text);

        const none = removeHook("claude", options(box));

        assert.equal(missing.changed, false);
        assert.equal(missing.removed, 0);
        assert.equal(none.changed, false);
        assert.equal(none.removed, 0);
        assert.equal(readFileSync(file, "utf8"), text);
    });

    it("throws on invalid JSON and leaves the file unchanged", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        writeFileSync(file, "{oops");

        assert.throws(() => removeHook("claude", options(box)), /not valid JSON/u);

        assert.equal(readFileSync(file, "utf8"), "{oops");
    });
});

describe("hookInstalled", () => {
    it("reports false without a file, true after install, false after removal", (t) => {
        const box = sandbox(t);
        const before = hookInstalled("claude", options(box));
        installHook("claude", { ...options(box), command: COMMAND });
        const installed = hookInstalled("claude", options(box));
        removeHook("claude", options(box));
        const after = hookInstalled("claude", options(box));

        assert.deepEqual([before, installed, after], [false, true, false]);
    });

    it("reports false for invalid JSON and for hooks of other tools", (t) => {
        const box = sandbox(t);
        const file = join(box.claudeDir, "settings.json");
        writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [OTHER_HOOK] }] } }));
        const other = hookInstalled("claude", options(box));
        writeFileSync(file, "{bad");
        const invalid = hookInstalled("claude", options(box));

        assert.deepEqual([other, invalid], [false, false]);
    });
});

describe("generated commands", () => {
    it("builds the MCP add command for Claude Code and Codex from PATH", () => {
        assert.equal(
            mcpAddCommand("claude", { onPath: true }),
            "claude mcp add --scope user lune-memory -- lune-memory mcp --harness claude",
        );
        assert.equal(
            mcpAddCommand("codex", { onPath: true }),
            "codex mcp add lune-memory -- lune-memory mcp --harness codex",
        );
    });

    it("passes --home and quotes values with spaces", () => {
        const actual = mcpAddCommand("claude", { onPath: true, memoryHome: "/tmp/my home" });

        assert.equal(
            actual,
            'claude mcp add --scope user lune-memory -- lune-memory --home "/tmp/my home" mcp --harness claude',
        );
    });

    it("runs node with the CLI file when lune-memory is not on PATH", () => {
        const actual = mcpAddCommand("codex", { onPath: false });

        assert.match(
            actual,
            /--disable-warning=ExperimentalWarning .*cli\.ts mcp --harness codex$/u,
        );
    });

    it("points the Pi install command at the package folder", () => {
        const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

        assert.equal(piInstallCommand(), `pi install ${packageDir}`);
    });
});

describe("sandboxHint", () => {
    it("gives Claude an allow rule for the views folder and names permissions.allow", () => {
        const actual = sandboxHint("claude", "/home/u/.lune-memory/views").join("\n");

        assert.ok(actual.includes("Read(//home/u/.lune-memory/views/**)"));
        assert.ok(actual.includes("permissions.allow"));
    });

    it("names the views folder for Codex and gives no Read rule", () => {
        const actual = sandboxHint("codex", "/home/u/.lune-memory/views").join("\n");

        assert.ok(actual.includes("/home/u/.lune-memory/views"));
        assert.ok(!actual.includes("Read("));
    });
});
