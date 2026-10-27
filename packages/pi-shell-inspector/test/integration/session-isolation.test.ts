/**
 * Isolation between two loads of the extension in one process.
 *
 * Pi caches an extension's factory per working directory, so a Lune Subagents run started in the
 * folder of the main session loads the same module again. Each load must own its job table: the
 * run's lifecycle events must not kill, list, clear or persist the main session's background
 * shells, and a job's completion notification belongs to the load that started it.
 *
 * Every test opens two sessions on the same working directory: A stands for the main session and
 * B for the run. A starts real background commands through its `bash` tool; B is driven through
 * its own tools and lifecycle events.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SHELL_STATUS_ENTRY, type ShellStatusSnapshot } from "../helpers/session-log.ts";
import {
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    resultText,
    sessionTool,
    startBackgroundBashCommand,
    waitFor,
    waitForJobSettled,
    type BashToolDefinition,
    type BashToolResult,
    type ExtensionSession,
} from "../harness.ts";

/** Execute signature shared by the two inspector tools; only the params and the result are read. */
type InspectorExecute = (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
) => Promise<BashToolResult>;

/** Call an inspector tool the way pi does and return the text it answers with. */
async function callTool(
    tool: BashToolDefinition,
    params: Record<string, unknown> = {},
): Promise<string> {
    const execute = tool.execute as unknown as InspectorExecute;
    return resultText(await execute("call-isolation", params, undefined, undefined, undefined));
}

/** Ids of the jobs captured by every shell snapshot a session appended to its log. */
function snapshotJobIds(session: ExtensionSession): string[] {
    return session.host.appendEntryCalls
        .filter((call) => call.customType === SHELL_STATUS_ENTRY)
        .flatMap((call) => (call.data as ShellStatusSnapshot).jobs.map((job) => job.id));
}

describe("pi-shell-inspector loads in one process", () => {
    const jobId = "call-main-job";
    let workDir: string;
    let main: ExtensionSession;
    let run: ExtensionSession;

    beforeEach(async () => {
        workDir = createTempWorkDir("isolation");
        main = await openSession(workDir);
        run = await openSession(workDir);
    });

    afterEach(async () => {
        await main.host.emit("session_shutdown", main.ctx);
        await run.host.emit("session_shutdown", run.ctx);
        removeTempWorkDir(workDir);
    });

    /** Start the long-running background job of the main session. */
    async function startMainJob(): Promise<void> {
        await startBackgroundBashCommand(main.tool, {
            command: "sleep 30",
            ctx: main.ctx,
            toolCallId: jobId,
        });
        assert.equal(
            main.manager.getJob(jobId)?.status,
            "running",
            "guard: the main session's job must be running",
        );
    }

    /** Assert the main session's job is still the same live, unsettled job. */
    function assertMainJobUntouched(message: string): void {
        const job = main.manager.getJob(jobId);
        assert.equal(job?.status, "running", `${message}: the job must keep running`);
        assert.equal(
            job?.controller.signal.aborted,
            false,
            `${message}: the job must not be aborted`,
        );
        assert.deepEqual(
            main.host.sendMessageCalls,
            [],
            `${message}: the main session must not be told about a kill`,
        );
    }

    it("keeps the main session's job running when another load starts its session", async () => {
        await startMainJob();

        const another = await openSession(workDir);
        try {
            assertMainJobUntouched("a second load's session_start");
            assert.deepEqual(
                another.manager.getAllJobsList(),
                [],
                "the new load must start with its own empty job table",
            );
        } finally {
            await another.host.emit("session_shutdown", another.ctx);
        }
    });

    it("lists no job in the run's background_shell while the main session's lists its job", async () => {
        await startMainJob();

        const expected = "No background shells.";
        const actual = await callTool(sessionTool(run, "background_shell"));
        const mainListing = await callTool(sessionTool(main, "background_shell"));

        assert.equal(actual, expected, "the run must not see the main session's job");
        assert.ok(
            mainListing.includes(jobId),
            `the main session must list its own job, got ${JSON.stringify(mainListing)}`,
        );
    });

    it("answers unknown for the main session's job id in the run's kill_background_shell", async () => {
        await startMainJob();

        const expected = `Unknown background shell: ${jobId}`;
        const actual = await callTool(sessionTool(run, "kill_background_shell"), { jobID: jobId });

        assert.equal(
            actual,
            expected,
            "the run must not be able to address the main session's job",
        );
        assertMainJobUntouched("a kill attempt from the run");
    });

    for (const event of ["session_shutdown", "session_before_tree"] as const) {
        it(`neither kills, clears nor persists the main session's job on the run's ${event}`, async () => {
            await startMainJob();
            const mainEntriesBefore = main.host.appendEntryCalls.length;

            await run.host.emit(event, run.ctx);

            assertMainJobUntouched(`the run's ${event}`);
            assert.deepEqual(
                main.manager.getAllJobsList().map((job) => job.id),
                [jobId],
                "the main session's job table must stay intact",
            );
            const expected: string[] = [];
            const actual = snapshotJobIds(run);
            assert.deepEqual(actual, expected, "the run's session log must not hold the main job");
            assert.equal(
                main.host.appendEntryCalls.length,
                mainEntriesBefore,
                "the main session's log must not be written by the run",
            );
        });
    }

    it("sends the completion notification through the starting load only", async () => {
        await startBackgroundBashCommand(main.tool, {
            command: "printf 'main-done\\n'",
            ctx: main.ctx,
            toolCallId: "call-main-done",
        });
        await waitForJobSettled(main.manager, "call-main-done");

        await waitFor(
            "the main session's notification",
            () => main.host.sendMessageCalls.length === 1,
        );
        // Let the run's notifier flush as well, had it been subscribed to the job.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const notification = main.host.sendMessageCalls[0]!;
        assert.match(
            String(notification.message.content),
            /^Background shell call-main-done completed\./,
            "the main session must be told that its own job completed",
        );
        assert.deepEqual(run.host.sendMessageCalls, [], "the run must receive no notification");
    });
});
