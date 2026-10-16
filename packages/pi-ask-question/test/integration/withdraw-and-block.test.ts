/**
 * Integration contract of `withdraw_user_questions` and of `ask_user_questions` in block mode.
 *
 * Like the other integration suites it drives the real `src/index.ts` through the fake pi host.
 * Panels are driven only far enough to settle, defer or observe a request; their key handling
 * is covered by `test/unit/question-panel.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { stripTerminalSequences } from "@earendil-works/pi-tui";

import luneAskQuestion from "../../src/index.ts";
import {
    QUESTION_STATE_ENTRY,
    questionManager,
    type AskQuestion,
    type AskQuestionStateSnapshot,
} from "../../src/core/questionManager.ts";
import { resetQuestionPanelState } from "../../src/tui/panel/question-panel.ts";
import {
    createFakeContext,
    createFakePiHost,
    createFakeTheme,
    createFakeUi,
    requireTool,
    type FakeBranchEntry,
    type FakePiHost,
    type FakeUi,
} from "../harness.ts";

const WIDGET_KEY = "pi-ask-question";
const ENTER = "\r";
const ESCAPE = "\x1b";

const QUESTIONS: AskQuestion[] = [
    {
        header: "Storage",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
];

const OTHER_QUESTIONS: AskQuestion[] = [
    {
        header: "Auth",
        question: "Which login?",
        options: [{ label: "OIDC" }, { label: "Password" }],
    },
];

type ToolResult = Awaited<ReturnType<ReturnType<typeof requireTool>["execute"]>>;

interface Session {
    readonly host: FakePiHost;
    readonly ui: FakeUi;
    readonly branch: FakeBranchEntry[];
}

const liveSessions: Session[] = [];

async function startSession(branch: FakeBranchEntry[] = []): Promise<Session> {
    const host = createFakePiHost(luneAskQuestion, { branch });
    const ui = createFakeUi();

    await host.fire("session_start", createFakeContext({ ui, branch }));

    const session = { host, ui, branch };
    liveSessions.push(session);

    return session;
}

function contextOf(session: Session) {
    return createFakeContext({ ui: session.ui, branch: session.host.branch });
}

async function restart(session: Session): Promise<Session> {
    await session.host.fire("session_shutdown", contextOf(session));

    return startSession(session.host.branch);
}

function textOf(result: ToolResult): string {
    return String(result.content[0]?.type === "text" ? result.content[0].text : "");
}

/** Create a request in continue mode and return its id; the panel it opens stays open. */
async function ask(session: Session, questions: AskQuestion[] = QUESTIONS): Promise<string> {
    const result = await requireTool(session.host, "ask_user_questions").execute(
        "call-ask",
        { questions },
        undefined,
        undefined,
        contextOf(session),
    );

    return (result.details as { requestId: string }).requestId;
}

function withdraw(session: Session, requestId: string, reason = "answered by the test run") {
    return requireTool(session.host, "withdraw_user_questions").execute(
        "call-withdraw",
        { requestId, reason },
        undefined,
        undefined,
        contextOf(session),
    );
}

interface BlockCall {
    readonly result: Promise<ToolResult>;
    readonly requestId: string;
    readonly updates: Array<{ details: unknown }>;
}

/** Start a blocking call without awaiting it; resolves once its request exists and is waited on. */
async function startBlock(
    session: Session,
    options: { signal?: AbortSignal; questions?: AskQuestion[] } = {},
): Promise<BlockCall> {
    const updates: Array<{ details: unknown }> = [];
    const before = new Set(questionManager.getPendingRequests().map((request) => request.id));

    const result = requireTool(session.host, "ask_user_questions").execute(
        "call-block",
        { questions: options.questions ?? QUESTIONS, mode: "block" },
        options.signal,
        (partial) => updates.push(partial),
        contextOf(session),
    );

    const created = questionManager.getPendingRequests().find((request) => !before.has(request.id));
    assert.ok(created, "a blocking call must create its request before it waits");

    return { result, requestId: created.id, updates };
}

function answerFocusedOption(ui: FakeUi): void {
    assert.ok(ui.panel, "expected an open question panel");
    ui.panel.handleInput?.(ENTER);
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
            return true;
        }

        await new Promise((resolve) => setImmediate(resolve));
    }

    return predicate();
}

async function drain(): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** The newest state snapshot on the branch, as a restore would read it. */
function newestSnapshot(branch: readonly FakeBranchEntry[]): AskQuestionStateSnapshot {
    const entry = branch
        .filter((item) => item.type === "custom" && item.customType === QUESTION_STATE_ENTRY)
        .at(-1);

    assert.ok(entry && entry.type === "custom", "expected a persisted question state");

    return entry.data as AskQuestionStateSnapshot;
}

function renderedText(component: { render(width: number): string[] }): string {
    return component
        .render(120)
        .map((line) => stripTerminalSequences(line).trim())
        .join("\n");
}

describe("withdraw and block", () => {
    beforeEach(() => {
        resetQuestionPanelState();
        questionManager.clearAll();
    });

    afterEach(async () => {
        for (const session of liveSessions.splice(0)) {
            await session.host.fire("session_shutdown", contextOf(session));
        }

        resetQuestionPanelState();
        questionManager.clearAll();
    });

    describe("withdraw_user_questions", () => {
        it("withdraws a pending request, sends nothing and persists its removal", async () => {
            const session = await startSession();
            const requestId = await ask(session);

            const result = await withdraw(session, requestId, "answered by the test run");

            assert.equal(result.isError, undefined);
            assert.equal(
                textOf(result),
                `Withdrew request ${requestId}. The user will not answer it.`,
            );
            assert.deepEqual(result.details, {
                status: "withdrawn",
                requestId,
                headers: "Storage",
                reason: "answered by the test run",
            });
            assert.equal(questionManager.getPendingRequests().length, 0);
            assert.deepEqual(session.host.sendMessageCalls, []);
            assert.deepEqual(newestSnapshot(session.host.branch), { requests: [], outbox: [] });
        });

        it("joins the headers of a request with several questions", async () => {
            const session = await startSession();
            const requestId = await ask(session, [...QUESTIONS, ...OTHER_QUESTIONS]);

            const result = await withdraw(session, requestId);

            assert.equal((result.details as { headers: string }).headers, "Storage, Auth");
        });

        it("closes the open panel, tells the user and does not open another one", async () => {
            const session = await startSession();
            const requestId = await ask(session);
            assert.equal(session.ui.customCalls.length, 1);
            const closed = session.ui.panelClosed;

            await withdraw(session, requestId, "replaced by a clearer question");
            await closed;
            await drain();

            assert.deepEqual(session.ui.notifyCalls, [
                {
                    message: "The agent withdrew: Storage (replaced by a clearer question)",
                    type: "info",
                },
            ]);
            assert.equal(session.ui.customCalls.length, 1, "nothing is left to show");
        });

        it("continues the panel loop with the next pending request", async () => {
            const session = await startSession();
            const first = await ask(session);
            const second = await ask(session, OTHER_QUESTIONS);
            assert.equal(session.ui.customCalls.length, 1);

            await withdraw(session, first);

            assert.ok(
                await waitUntil(() => session.ui.customCalls.length === 2),
                "the loop must open the next pending request",
            );
            assert.equal(questionManager.getPendingRequests()[0]?.id, second);
            assert.match(
                stripTerminalSequences(session.ui.panel!.render(120).join("\n")),
                /Which login\?/,
            );
        });

        it("does not touch a panel that shows another request", async () => {
            const session = await startSession();
            const shown = await ask(session);
            const other = await ask(session, OTHER_QUESTIONS);

            await withdraw(session, other);
            await drain();

            assert.equal(session.ui.customCalls.length, 1);
            assert.deepEqual(session.ui.notifyCalls, []);
            assert.ok(questionManager.getPendingRequest(shown));
        });

        it("reports too late for an answered request still in the outbox", async () => {
            const session = await startSession();
            const requestId = await ask(session);
            answerFocusedOption(session.ui);

            const result = await withdraw(session, requestId);

            assert.equal(result.isError, undefined);
            assert.deepEqual(result.details, { status: "too-late", requestId });
            assert.ok(
                textOf(result).startsWith(
                    `Too late: the user already answered request ${requestId}.`,
                ),
            );
            assert.match(textOf(result), /will arrive as a follow-up message/);
            assert.equal(session.host.sendMessageCalls.length, 1, "the answer is still delivered");
        });

        it("reports too late for a skipped request still in the outbox", async () => {
            const session = await startSession();
            const requestId = await ask(session);
            session.ui.panel!.handleInput?.("S");

            const result = await withdraw(session, requestId);

            assert.deepEqual(result.details, { status: "too-late", requestId });
            assert.ok(
                textOf(result).startsWith(
                    `Too late: the user already skipped request ${requestId}.`,
                ),
            );
        });

        it("reports too late when the answer message is already on the branch", async () => {
            const session = await startSession();
            const requestId = await ask(session);
            answerFocusedOption(session.ui);
            session.host.commitSendMessage(0);
            await session.host.fire("agent_settled", contextOf(session));
            assert.equal(
                questionManager.get(requestId),
                undefined,
                "guard: the request left the outbox",
            );

            const result = await withdraw(session, requestId);

            assert.equal(result.isError, undefined);
            assert.deepEqual(result.details, { status: "too-late", requestId });
            assert.match(textOf(result), /already in the conversation/);
        });

        it("refuses an unknown request id", async () => {
            const session = await startSession();

            const result = await withdraw(session, "deadbeef");

            assert.equal(result.isError, true);
            assert.deepEqual(result.details, { status: "refused", requestId: "deadbeef" });
        });

        it("withdraws a request restored from an older snapshot under its UUID id", async () => {
            const uuid = "5f0c6a52-9d3b-4c9e-8a57-0b6f2d1e7c11";
            const session = await startSession([
                {
                    type: "custom",
                    customType: QUESTION_STATE_ENTRY,
                    data: {
                        requests: [
                            {
                                id: uuid,
                                createdAt: 1,
                                status: "pending",
                                questions: QUESTIONS,
                            },
                        ],
                        outbox: [],
                    },
                },
            ]);
            assert.ok(questionManager.getPendingRequest(uuid), "guard: the request was restored");

            const result = await withdraw(session, uuid);

            assert.equal((result.details as { status: string }).status, "withdrawn");
            assert.equal(questionManager.getPendingRequests().length, 0);
        });

        it("renders a withdrawn result as a one-line card", async () => {
            const session = await startSession();
            const requestId = await ask(session);
            const tool = requireTool(session.host, "withdraw_user_questions");
            const result = await withdraw(session, requestId, "answered by the test run");

            const component = tool.renderResult!(result, {}, createFakeTheme(), {});

            assert.equal(
                renderedText(component),
                "Question withdrawn · Storage · answered by the test run",
            );
        });
    });

    describe("ask_user_questions block mode", () => {
        it("reports waiting once and holds the request as waited on", async () => {
            const session = await startSession();

            const call = await startBlock(session);

            assert.deepEqual(
                call.updates.map((update) => update.details),
                [{ status: "waiting", requestId: call.requestId }],
            );
            assert.equal(questionManager.isWaiting(call.requestId), true);
            assert.equal(questionManager.nextPendingRequest()?.id, call.requestId);

            answerFocusedOption(session.ui);
            await call.result;
        });

        it("returns the answer as the tool result without a message or outbox entry", async () => {
            const session = await startSession();
            const call = await startBlock(session);

            answerFocusedOption(session.ui);
            const result = await call.result;

            assert.equal(result.isError, undefined);
            assert.equal(
                textOf(result),
                [
                    "The user answered these questions.",
                    "",
                    "Which database?",
                    "answer: selected: 1. Postgres",
                ].join("\n"),
            );
            assert.deepEqual(result.details, {
                status: "answered",
                requestId: call.requestId,
                questions: [
                    {
                        header: "Storage",
                        question: "Which database?",
                        options: [{ label: "Postgres" }, { label: "SQLite" }],
                    },
                ],
                answers: [{ selectedIndexes: [0] }],
            });
            assert.deepEqual(session.host.sendMessageCalls, []);
            assert.deepEqual(questionManager.getUndeliveredRequests(), []);
            assert.deepEqual(newestSnapshot(session.host.branch), { requests: [], outbox: [] });
        });

        it("returns a skip as the tool result without a message", async () => {
            const session = await startSession();
            const call = await startBlock(session);

            session.ui.panel!.handleInput?.("S");
            const result = await call.result;

            assert.equal((result.details as { status: string }).status, "skipped");
            assert.ok(
                textOf(result).startsWith("The user skipped these questions without answering."),
            );
            assert.deepEqual(session.host.sendMessageCalls, []);
            assert.deepEqual(questionManager.getUndeliveredRequests(), []);
        });

        it("returns interrupted on abort and delivers a later answer as a message", async () => {
            const session = await startSession();
            const controller = new AbortController();
            const call = await startBlock(session, { signal: controller.signal });

            controller.abort();
            const result = await call.result;

            assert.ok(textOf(result).startsWith("Interrupted before the user answered."));
            assert.ok(textOf(result).includes(`Request id: ${call.requestId}`));
            assert.deepEqual(result.details, { status: "interrupted", requestId: call.requestId });
            assert.ok(questionManager.getPendingRequest(call.requestId));
            assert.equal(questionManager.isWaiting(call.requestId), false);

            answerFocusedOption(session.ui);

            assert.equal(session.host.sendMessageCalls.length, 1);
            assert.equal(questionManager.getUndeliveredRequests().length, 1);
        });

        it("returns interrupted at once for a signal that is already aborted", async () => {
            const session = await startSession();

            const call = await startBlock(session, { signal: AbortSignal.abort() });
            const result = await call.result;

            assert.deepEqual(result.details, { status: "interrupted", requestId: call.requestId });
            assert.ok(questionManager.getPendingRequest(call.requestId));
            assert.equal(questionManager.isWaiting(call.requestId), false);
        });

        it("lets the agent withdraw the request after its wait was aborted", async () => {
            const session = await startSession();
            const controller = new AbortController();
            const call = await startBlock(session, { signal: controller.signal });
            controller.abort();
            await call.result;

            const result = await withdraw(session, call.requestId);

            assert.equal((result.details as { status: string }).status, "withdrawn");
            assert.equal(questionManager.getPendingRequests().length, 0);
        });

        it("refuses to withdraw a request a blocking call waits on", async () => {
            const session = await startSession();
            const call = await startBlock(session);

            const result = await withdraw(session, call.requestId);

            assert.equal(result.isError, true);
            assert.deepEqual(result.details, { status: "refused", requestId: call.requestId });
            assert.ok(questionManager.getPendingRequest(call.requestId));
            assert.equal(questionManager.isWaiting(call.requestId), true);

            answerFocusedOption(session.ui);
            const answered = await call.result;

            assert.equal((answered.details as { status: string }).status, "answered");
        });

        it("resolves a waiting call as interrupted at a session boundary and restores the request", async () => {
            const session = await startSession();
            const call = await startBlock(session);

            const next = await restart(session);
            const result = await call.result;

            assert.deepEqual(result.details, { status: "interrupted", requestId: call.requestId });
            assert.ok(
                questionManager.getPendingRequest(call.requestId),
                "the branch brings the request back as pending",
            );
            assert.equal(questionManager.isWaiting(call.requestId), false);

            void next.host.commands.get("question")!.handler("", contextOf(next));
            assert.ok(await waitUntil(() => next.ui.panel !== undefined));
            answerFocusedOption(next.ui);

            assert.equal(next.host.sendMessageCalls.length, 1);
            assert.equal(session.host.sendMessageCalls.length, 0);
        });

        it("keeps waiting after Esc and reopens the waited-on request first with /question", async () => {
            const session = await startSession();
            const other = await ask(session, OTHER_QUESTIONS);
            const call = await startBlock(session);
            let settled = false;
            void call.result.then(() => {
                settled = true;
            });
            assert.equal(questionManager.nextPendingRequest()?.id, call.requestId);
            const callsBefore = session.ui.customCalls.length;

            session.ui.panel!.handleInput?.(ESCAPE);
            await session.ui.panelClosed;
            await drain();

            assert.equal(settled, false, "Esc defers; it does not end the wait");
            assert.equal(questionManager.isWaiting(call.requestId), true);

            const command = session.host.commands.get("question");
            assert.ok(command);
            void command.handler("", contextOf(session));

            assert.ok(await waitUntil(() => session.ui.customCalls.length === callsBefore + 1));
            assert.match(
                stripTerminalSequences(session.ui.panel!.render(120).join("\n")),
                /Which database\?/,
            );

            answerFocusedOption(session.ui);
            await call.result;
            assert.ok(questionManager.getPendingRequest(other));
        });

        it("returns the unavailable error outside the TUI", async () => {
            const session = await startSession();
            const ui = createFakeUi();

            const result = await requireTool(session.host, "ask_user_questions").execute(
                "call-1",
                { questions: QUESTIONS, mode: "block" },
                undefined,
                undefined,
                createFakeContext({ ui, mode: "print", hasUI: false }),
            );

            assert.equal(result.isError, true);
            assert.deepEqual(result.details, { status: "unavailable" });
            assert.equal(questionManager.getPendingRequests().length, 0);
        });

        it("shows the waiting mark in the below-editor row and drops it after an abort", async () => {
            const session = await startSession();
            const controller = new AbortController();

            await startBlock(session, { signal: controller.signal });

            assert.equal(
                session.ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0],
                "1 pending question · agent waiting · Which database? · /question to answer",
            );

            controller.abort();
            await drain();

            assert.equal(
                session.ui.mountedWidget("belowEditor", WIDGET_KEY)?.[0],
                "1 pending question · Which database? · /question to answer",
            );
        });
    });
});
