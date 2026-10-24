import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { runSessionFile } from "../../src/paths.ts";
import { createRunFile } from "../../src/run/run-file.ts";
import { assistantMessage, tempAgentDir, userMessage } from "./support.ts";

// The design: Pi's /resume and Core's @ mentions list only `SessionManager.listAll()`, which reads
// <agentDir>/sessions, so a run session stored beside the definitions never appears.
test("SessionManager.listAll returns an ordinary session and never a run session", async (t) => {
    const agentDir = tempAgentDir(t);
    const projectDir = join(agentDir, "sessions", "--work-project--");
    const ordinary = SessionManager.create("/work/project", projectDir);

    ordinary.appendMessage(userMessage("hello") as never);
    ordinary.appendMessage(assistantMessage("hi") as never);

    const file = runSessionFile(ordinary.getSessionId(), "run-session-1", agentDir);
    const run = createRunFile(file, { runId: "run-session-1", cwd: "/work/project" });

    run.appendMessage(userMessage("run task") as never);
    run.appendMessage(assistantMessage("run answer") as never);

    const listed = await SessionManager.listAll();

    assert.deepEqual(
        listed.map((session) => session.id),
        [ordinary.getSessionId()],
    );
});
