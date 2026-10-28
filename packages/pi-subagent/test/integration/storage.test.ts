import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createFixture, reportResponse, waitForTurns } from "../harness/fixture.ts";

test("Pi's session listing, used by /resume and @ mentions, never returns a run session", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    // A normal session in Pi's own sessions folder, as the positive control.
    const ordinary = SessionManager.create(fx.cwd);

    ordinary.appendMessage({ role: "user", content: "an ordinary session", timestamp: 1 });
    ordinary.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
    } as never);

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const listed = await SessionManager.listAll();

    assert.ok(listed.some((session) => session.id === ordinary.getSessionId()));
    assert.ok(!listed.some((session) => session.id === run.id));
    assert.ok(!listed.some((session) => session.path.includes("lune-subagents")));
});
