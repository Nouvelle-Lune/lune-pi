import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreSettings } from "../../src/core/settings.ts";
import luneCore from "../../src/extension.ts";
import { createSettingsSandbox } from "../../src/testing/index.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Enough 9000-character sessions that one MB cannot index all of them but two MB can. */
const SESSIONS = 80;
const sessionId = (n: number) => `s${String(n).padStart(3, "0")}-0000000000000`;

async function startCore(t: TestContext) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-core-budget-" });
    t.after(() => sandbox.dispose());
    const root = path.dirname(sandbox.agentDir);
    isolateExternalSessions(t, root);
    // Transcript copies of mentioned sessions go to the temp directory.
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, "tmp");
    t.after(() => {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    });
    await mkdir(process.env.TMPDIR, { recursive: true });
    const projectDir = path.join(sandbox.agentDir, "sessions", "--work--");
    await mkdir(projectDir, { recursive: true });
    for (let n = 1; n <= SESSIONS; n++) {
        const file = new SessionFile(sessionId(n), "/work");
        // The newest activity belongs to the highest number.
        file.message({ role: "user", content: "x".repeat(9_000), timestamp: Date.UTC(2026, 0, n) });
        await writeFile(
            path.join(projectDir, `2026-01-01T00-00-00-000Z_${sessionId(n)}.jsonl`),
            file.jsonl(),
        );
    }

    const handlers = new Map<string, Handler[]>();
    const notices: string[] = [];
    const ctx = {
        mode: "tui",
        hasUI: true,
        cwd: sandbox.cwd,
        isProjectTrusted: () => true,
        ui: {
            notify: (message: string) => notices.push(message),
            setEditorText: () => undefined,
            addAutocompleteProvider: () => undefined,
        },
        sessionManager: SessionManager.inMemory(sandbox.cwd),
    };
    await luneCore({
        on(name: string, handler: Handler) {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
            return () =>
                handlers.set(
                    name,
                    handlers.get(name)!.filter((each) => each !== handler),
                );
        },
        registerCommand: () => undefined,
    } as unknown as ExtensionAPI);
    const emit = async (type: string, event: object = {}) => {
        // Handlers run in registration order, so Core's settings are bound before mentions read them.
        for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
    };
    t.after(() => emit("session_shutdown"));
    const start = () => emit("session_start");
    /** Whether the mention of one session is accepted rather than refused as unknown. */
    const mentions = async (n: number) => {
        const [handler] = handlers.get("input")!;
        const result = (await handler!(
            { type: "input", text: `@session:${sessionId(n)}`, images: [] },
            ctx,
        )) as { action: string };
        return result.action === "transform";
    };
    return { sandbox, start, mentions, notices };
}

test("Core's cache size setting limits the mentionable sessions to the newest that fit, and a change applies at the next session start", async (t) => {
    const env = await startCore(t);
    await env.sandbox.writeStored(coreSettings, "global", { mention: { cacheSizeMB: 1 } });

    await env.start();
    const small = { oldest: await env.mentions(1), newest: await env.mentions(SESSIONS) };
    await env.sandbox.writeStored(coreSettings, "global", { mention: { cacheSizeMB: 2 } });
    await env.start();
    const large = { oldest: await env.mentions(1), newest: await env.mentions(SESSIONS) };

    assert.deepEqual(small, { oldest: false, newest: true });
    assert.deepEqual(large, { oldest: true, newest: true });
});
