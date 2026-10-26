import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager, type InputEventResult } from "@earendil-works/pi-coding-agent";
import type { MentionNotice } from "../harness/mention-runtime.ts";
import { createMentionHost } from "../harness/mention-runtime.ts";
import { SessionFile } from "../harness/session-fixtures.ts";

const execFileAsync = promisify(execFile);
const scenarioFixture = fileURLToPath(
    new URL("../harness/mention-lifecycle-scenario.ts", import.meta.url),
);
const TARGET_ID = "01a14931-31bb-7000-8000-bbbbbbbbbbbb";

interface ScenarioOutput {
    scenario: string;
    scans: number;
    scanWasAborted: boolean;
    bindings: number;
    notices: MentionNotice[];
    errors: { message?: string; event?: string }[];
    mention?: InputEventResult;
}

interface IsolatedEnvironment {
    root: string;
    agentDir: string;
    cwd: string;
    sessionDir: string;
    tempDir: string;
}

const environmentVariables = (root: string) => ({
    PI_CODING_AGENT_DIR: join(root, "agent"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
});

async function isolatedEnvironment(t: TestContext): Promise<IsolatedEnvironment> {
    const root = await mkdtemp(join(tmpdir(), "mention-lifecycle-"));
    const directories = environmentVariables(root);
    const previous = new Map(Object.keys(directories).map((key) => [key, process.env[key]]));
    for (const [key, directory] of Object.entries(directories)) process.env[key] = directory;
    t.after(() => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    await Promise.all(
        [cwd, sessionDir, ...Object.values(directories)].map((directory) =>
            mkdir(directory, { recursive: true }),
        ),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    return {
        root,
        agentDir: directories.PI_CODING_AGENT_DIR,
        cwd,
        sessionDir,
        tempDir: directories.TMPDIR,
    };
}

async function runScenario(root: string, scenario: string, lateFailure?: "io-error") {
    try {
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [
                "--experimental-strip-types",
                // Node's default mode, pinned so an inherited NODE_OPTIONS cannot soften it.
                "--unhandled-rejections=throw",
                scenarioFixture,
                scenario,
                ...(lateFailure ? [lateFailure] : []),
            ],
            {
                cwd: join(root, "project"),
                env: { ...process.env, ...environmentVariables(root) },
                timeout: 30_000,
                killSignal: "SIGKILL",
                maxBuffer: 1024 * 1024,
            },
        );
        return { code: 0, stdout, stderr };
    } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string };
        return {
            code: failure.code ?? "killed",
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
        };
    }
}

function scenarioResult(stdout: string, stderr: string): ScenarioOutput {
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    assert.ok(line, `child printed no result\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    return JSON.parse(line.slice("RESULT ".length)) as ScenarioOutput;
}

/** A bounded wait, so a missing notice fails instead of hanging the suite. */
async function within<T>(promise: Promise<T>, description: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${description} did not happen`)),
                    10_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

const scenarioCases = [
    { scenario: "reload", lateFailure: undefined },
    { scenario: "new", lateFailure: undefined },
    { scenario: "fork", lateFailure: undefined },
    { scenario: "resume", lateFailure: undefined },
    { scenario: "shutdown", lateFailure: undefined },
    { scenario: "reload", lateFailure: "io-error" },
] as const;

for (const { scenario, lateFailure } of scenarioCases) {
    const release = lateFailure
        ? `released after ${scenario} with an I/O error`
        : `released after ${scenario}`;
    test(`a pending startup scan ${release} does not crash through a stale context`, async (t) => {
        const environment = await isolatedEnvironment(t);

        const actual = await runScenario(environment.root, scenario, lateFailure);

        assert.doesNotMatch(
            actual.stderr,
            /stale after session replacement/,
            `the old session context must not be used:\n${actual.stderr}`,
        );
        assert.equal(
            actual.code,
            0,
            `${scenario} must exit cleanly\nstdout:\n${actual.stdout}\nstderr:\n${actual.stderr}`,
        );
        const output = scenarioResult(actual.stdout, actual.stderr);
        assert.equal(output.scanWasAborted, true, "the fixture must cancel the old scan");
        assert.deepEqual(output.notices, []);
        assert.deepEqual(output.errors, []);
        if (scenario === "shutdown") {
            assert.equal(output.mention, undefined);
            return;
        }
        assert.equal(output.mention?.action, "transform");
        const text = output.mention?.text;
        assert.ok(text, `a mention must still complete:\n${actual.stdout}`);
        const expectedPrefix = `@${join(
            environment.tempDir,
            "pi-lune-session-refs",
            `pi.${TARGET_ID}.`,
        )}`;
        assert.ok(text.startsWith(expectedPrefix), text);
        assert.ok(text.endsWith(".md"), text);
        assert.deepEqual(output.mention?.images, []);
    });
}

test("a session list failure during startup is reported through the active UI", async (t) => {
    const environment = await isolatedEnvironment(t);
    t.mock.method(SessionManager, "listAll", async () => {
        throw new Error("catalog read failed");
    });
    const host = await createMentionHost({
        cwd: environment.cwd,
        agentDir: environment.agentDir,
        sessionManager: SessionManager.create(environment.cwd, environment.sessionDir),
    });
    t.after(() => host.dispose());

    const actual = await within(host.bindings[0]!.firstNotice, "startup load error notice");

    const expected = { message: "Session list failed: catalog read failed", type: "error" };
    assert.deepEqual(actual, expected);
    assert.deepEqual(host.bindings[0]!.errors, []);
    await host.dispose();
});

test("a session list failure after replacement is reported through the new session's UI", async (t) => {
    const environment = await isolatedEnvironment(t);
    const target = new SessionFile(TARGET_ID, environment.cwd);
    target.user("earlier question");
    await writeFile(
        join(environment.sessionDir, `2026-01-01T00-00-00-000Z_${TARGET_ID}.jsonl`),
        target.jsonl(),
    );
    const listAll = t.mock.method(SessionManager, "listAll");
    const host = await createMentionHost({
        cwd: environment.cwd,
        agentDir: environment.agentDir,
        sessionManager: SessionManager.create(environment.cwd, environment.sessionDir),
    });
    t.after(() => host.dispose());
    // A successful mention awaits the startup scan, so no scan is pending at replacement.
    const firstMention = await host.runtime.session.extensionRunner.emitInput(
        `@session:${TARGET_ID.slice(0, 13)}`,
        [],
        "interactive",
    );
    assert.equal(firstMention.action, "transform");
    listAll.mock.mockImplementation(async () => {
        throw new Error("replacement scan failed");
    });

    await host.runtime.newSession();

    const actual = await within(host.bindings[1]!.firstNotice, "replacement load error notice");

    const expected = { message: "Session list failed: replacement scan failed", type: "error" };
    assert.equal(host.bindings.length, 2);
    assert.deepEqual(actual, expected);
    assert.deepEqual(host.bindings[0]!.notices, []);
    assert.deepEqual(host.bindings[1]!.errors, []);
    await host.dispose();
});
