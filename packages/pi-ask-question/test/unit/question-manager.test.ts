import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
    QUESTION_STATE_ENTRY,
    QuestionManager,
    questionManager,
    type AskQuestion,
    type QuestionManagerEvent,
} from "../../src/core/questionManager.ts";
import { createFakeContext, createFakePiHost, type FakeBranchEntry } from "../harness.ts";

const QUESTIONS: AskQuestion[] = [
    {
        question: "Which database?",
        options: [{ label: "Postgres", description: "server" }, { label: "SQLite" }],
    },
    {
        question: "Anything else?",
    },
];

function newManager(): QuestionManager {
    return new QuestionManager();
}

/** `getBranch` entries carrying one state snapshot, as a resumed session would have. */
function branchWith(snapshot: unknown, customType = QUESTION_STATE_ENTRY): FakeBranchEntry[] {
    return [{ type: "custom", customType, data: snapshot }];
}

describe("question manager", () => {
    beforeEach(() => {
        // Module state is shared inside this test process; the extension tests use the singleton.
        questionManager.clearAll();
    });

    describe("create", () => {
        it("creates a pending request with an empty draft per question", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(request.status, "pending");
            assert.equal(request.questions.length, 2);
            assert.deepEqual(request.draft.answers, [undefined, undefined]);
            assert.deepEqual(request.draft.customDrafts, [undefined, undefined]);
            assert.deepEqual(request.draft.currentIndex, 0);
        });

        it("copies the questions so later mutation cannot change the request", () => {
            const manager = newManager();
            const questions: AskQuestion[] = [
                { question: "First", options: [{ label: "A" }, { label: "B" }] },
            ];
            const request = manager.create(questions);

            questions[0]!.question = "changed";
            questions[0]!.options![0]!.label = "changed";

            assert.equal(request.questions[0]!.question, "First");
            assert.equal(request.questions[0]!.options![0]!.label, "A");
        });

        it("lists pending requests oldest first", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create([{ question: "Later" }]);

            // The clock may be too coarse to separate the two timestamps; order comes from
            // the manager walking its map in insertion order plus the sort.
            assert.deepEqual(
                manager.getPendingRequests().map((request) => request.id),
                [first.id, second.id],
            );
        });

        it("emits a created event", () => {
            const manager = newManager();
            const events: QuestionManagerEvent[] = [];
            manager.subscribe((event) => events.push(event));

            const request = manager.create(QUESTIONS);

            assert.deepEqual(events, [{ type: "request-created", id: request.id }]);
        });
    });

    describe("submit and skip", () => {
        it("stores the answers and settles the request once", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(
                manager.submit(request.id, [
                    { selectedIndexes: [1] },
                    { selectedIndexes: [], customText: "yes" },
                ]),
                true,
            );
            assert.equal(manager.get(request.id)?.status, "answered");
            assert.deepEqual(manager.get(request.id)?.answers, [
                { selectedIndexes: [1] },
                { selectedIndexes: [], customText: "yes" },
            ]);

            // A second settle is a no-op: the answers were already delivered.
            assert.equal(
                manager.submit(request.id, [{ selectedIndexes: [0] }, { selectedIndexes: [0] }]),
                false,
            );
            assert.deepEqual(manager.get(request.id)?.answers?.[0], { selectedIndexes: [1] });
            assert.equal(manager.getPendingRequests().length, 0);
        });

        it("skips without answers and refuses a submit afterwards", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            assert.equal(manager.skip(request.id), true);
            assert.equal(manager.get(request.id)?.status, "skipped");
            assert.equal(manager.get(request.id)?.answers, undefined);
            assert.equal(manager.submit(request.id, []), false);
            assert.equal(manager.get(request.id)?.status, "skipped");
        });

        it("emits answered and skipped events", () => {
            const manager = newManager();
            const events: QuestionManagerEvent[] = [];
            manager.subscribe((event) => events.push(event));

            const answered = manager.create([{ question: "First" }]);
            manager.submit(answered.id, [{ selectedIndexes: [0] }]);
            const skipped = manager.create([{ question: "Second" }]);
            manager.skip(skipped.id);

            assert.deepEqual(events, [
                { type: "request-created", id: answered.id },
                { type: "request-answered", id: answered.id },
                { type: "request-created", id: skipped.id },
                { type: "request-skipped", id: skipped.id },
            ]);
        });

        it("returns undefined for a settled request", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            manager.skip(request.id);

            assert.equal(manager.getPendingRequest(request.id), undefined);
        });

        it("ignores unknown ids", () => {
            const manager = newManager();

            assert.equal(manager.submit("missing", []), false);
            assert.equal(manager.skip("missing"), false);
        });
    });

    describe("request ids", () => {
        it("creates ids of eight lowercase hex characters", () => {
            const manager = newManager();

            for (let index = 0; index < 50; index++) {
                assert.match(manager.create(QUESTIONS).id, /^[0-9a-f]{8}$/);
            }
        });

        it("never reuses the id of a live pending or outbox request", () => {
            const manager = newManager();
            const answered = manager.create(QUESTIONS);
            manager.skip(answered.id);
            const live = new Set([answered.id]);

            for (let index = 0; index < 200; index++) {
                const request = manager.create(QUESTIONS);

                assert.equal(live.has(request.id), false, `duplicate id ${request.id}`);
                live.add(request.id);
            }
        });

        it("keeps the UUID id of a request restored from an older snapshot and withdraws it", () => {
            const manager = newManager();
            const uuid = "5f0c6a52-9d3b-4c9e-8a57-0b6f2d1e7c11";
            const ctx = createFakeContext({
                branch: branchWith({
                    requests: [
                        {
                            id: uuid,
                            createdAt: 1,
                            status: "pending",
                            questions: [{ header: "Storage", question: "Which database?" }],
                        },
                    ],
                    outbox: [],
                }),
            });

            manager.restore(ctx);

            assert.equal(manager.getPendingRequest(uuid)?.id, uuid);
            assert.equal(manager.withdraw(uuid, "not needed").status, "withdrawn");
            assert.equal(manager.getPendingRequests().length, 0);
        });
    });

    describe("withdraw", () => {
        it("removes a pending request without an outbox entry and emits the reason", () => {
            const manager = newManager();
            const events: QuestionManagerEvent[] = [];
            const request = manager.create(QUESTIONS);
            manager.subscribe((event) => events.push(event));

            const outcome = manager.withdraw(request.id, "answered by the test run");

            assert.equal(outcome.status, "withdrawn");
            assert.equal(outcome.status === "withdrawn" && outcome.request.id, request.id);
            assert.equal(manager.getPendingRequest(request.id), undefined);
            assert.deepEqual(manager.getUndeliveredRequests(), []);
            assert.deepEqual(events, [
                { type: "request-withdrawn", id: request.id, reason: "answered by the test run" },
            ]);
        });

        it("reports a settled request in the outbox and leaves it there", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            manager.skip(request.id);

            const outcome = manager.withdraw(request.id, "late");

            assert.equal(outcome.status, "settled");
            assert.equal(manager.getUndeliveredRequests().length, 1);
        });

        it("reports an unknown id", () => {
            assert.deepEqual(newManager().withdraw("missing", "reason"), { status: "unknown" });
        });

        it("reports a request a blocking call waits on and keeps it pending", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            void manager.waitForSettle(request.id, undefined);

            const outcome = manager.withdraw(request.id, "reason");

            assert.deepEqual(outcome, { status: "waiting" });
            assert.ok(manager.getPendingRequest(request.id));
        });

        it("lets the first of withdraw, submit and skip win", () => {
            const manager = newManager();
            const withdrawn = manager.create(QUESTIONS);
            manager.withdraw(withdrawn.id, "reason");

            assert.equal(manager.submit(withdrawn.id, []), false);
            assert.equal(manager.skip(withdrawn.id), false);
            assert.deepEqual(manager.getUndeliveredRequests(), []);

            const answered = manager.create(QUESTIONS);
            manager.submit(answered.id, [{ selectedIndexes: [0] }, { selectedIndexes: [0] }]);

            assert.equal(manager.withdraw(answered.id, "reason").status, "settled");
        });

        it("withdraws a request again once its wait was aborted", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const controller = new AbortController();
            const wait = manager.waitForSettle(request.id, controller.signal);

            controller.abort();
            await wait;

            assert.equal(manager.withdraw(request.id, "reason").status, "withdrawn");
        });
    });

    describe("waiting for a settle", () => {
        it("resolves with the settled request and skips the outbox", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const wait = manager.waitForSettle(request.id, undefined);

            assert.equal(manager.isWaiting(request.id), true);

            manager.submit(request.id, [{ selectedIndexes: [1] }, { selectedIndexes: [0] }]);
            const outcome = await wait;

            assert.equal(outcome.status, "settled");
            assert.equal(
                outcome.status === "settled" && outcome.request.status,
                "answered",
                "the wait carries the answer",
            );
            assert.equal(manager.isWaiting(request.id), false);
            assert.deepEqual(manager.getUndeliveredRequests(), []);
            assert.equal(manager.getPendingRequest(request.id), undefined);
        });

        it("resolves a skip as settled without an outbox entry", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const wait = manager.waitForSettle(request.id, undefined);

            manager.skip(request.id);
            const outcome = await wait;

            assert.equal(outcome.status === "settled" && outcome.request.status, "skipped");
            assert.deepEqual(manager.getUndeliveredRequests(), []);
        });

        it("resolves as interrupted on abort and keeps the request pending", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const controller = new AbortController();
            const events: QuestionManagerEvent[] = [];
            const wait = manager.waitForSettle(request.id, controller.signal);
            manager.subscribe((event) => events.push(event));

            controller.abort();

            assert.deepEqual(await wait, { status: "interrupted" });
            assert.equal(manager.isWaiting(request.id), false);
            assert.ok(manager.getPendingRequest(request.id));
            assert.deepEqual(events, [{ type: "request-wait-ended", id: request.id }]);

            manager.submit(request.id, [{ selectedIndexes: [0] }, { selectedIndexes: [0] }]);

            assert.equal(manager.getUndeliveredRequests().length, 1, "a later answer is a message");
        });

        it("resolves at once as interrupted for a signal that is already aborted", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            const outcome = await manager.waitForSettle(request.id, AbortSignal.abort());

            assert.deepEqual(outcome, { status: "interrupted" });
            assert.equal(manager.isWaiting(request.id), false);
            assert.ok(manager.getPendingRequest(request.id));
        });

        it("resolves as interrupted when all state is cleared", async () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const wait = manager.waitForSettle(request.id, undefined);

            manager.clearAll();

            assert.deepEqual(await wait, { status: "interrupted" });
            assert.equal(manager.isWaiting(request.id), false);
        });

        it("rejects a second waiter and an unknown request", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            void manager.waitForSettle(request.id, undefined);

            assert.throws(() => manager.waitForSettle(request.id, undefined));
            assert.throws(() => manager.waitForSettle("missing", undefined));
        });

        it("shows the waited-on request first, also ahead of requests never shown", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create(QUESTIONS);
            manager.markShown(second.id);
            const third = manager.create(QUESTIONS);

            void manager.waitForSettle(second.id, undefined);

            assert.equal(manager.nextPendingRequest()?.id, second.id);
            assert.notEqual(first.id, third.id);
        });
    });

    describe("showing order", () => {
        it("prefers a request that was never shown", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create(QUESTIONS);

            manager.markShown(first.id);

            assert.equal(manager.nextPendingRequest()?.id, second.id);
        });

        it("falls back to the request that was shown least recently", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create(QUESTIONS);

            manager.markShown(first.id);
            manager.markShown(second.id);

            assert.equal(manager.nextPendingRequest()?.id, first.id);
        });

        it("keeps the createdAt order between requests that were never shown", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            manager.create(QUESTIONS);

            assert.equal(manager.nextPendingRequest()?.id, first.id);
        });

        it("ignores settled requests", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            manager.submit(request.id, [{ selectedIndexes: [0] }, { selectedIndexes: [0] }]);

            assert.equal(manager.nextPendingRequest(), undefined);
        });

        it("ignores an unknown id when marking a request as shown", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            manager.markShown("missing");

            assert.equal(manager.get(request.id)?.shownSeq, undefined);
        });

        it("emits a shown event so every ordering reader sees the move", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const events: QuestionManagerEvent[] = [];
            manager.subscribe((event) => events.push(event));

            manager.markShown(request.id);
            manager.markShown("missing");

            assert.deepEqual(events, [{ type: "request-shown", id: request.id }]);
        });

        it("keeps the showing order across a restore", () => {
            const manager = newManager();
            const first = manager.create(QUESTIONS);
            const second = manager.create(QUESTIONS);

            manager.markShown(first.id);
            manager.markShown(second.id);

            const resumed = newManager();
            resumed.restore(createFakeContext({ branch: branchWith(manager.snapshot()) }));

            assert.equal(
                resumed.nextPendingRequest()?.id,
                first.id,
                "the least recently shown one comes first",
            );

            // A request that arrives after the restart still outranks the restored ones.
            const third = resumed.create(QUESTIONS);

            assert.equal(resumed.nextPendingRequest()?.id, third.id);
        });
    });

    describe("persistence", () => {
        it("persists the pending requests at the state entry key", () => {
            const manager = newManager();
            const answered = manager.create([{ question: "Answered" }]);
            const pending = manager.create(QUESTIONS);
            manager.submit(answered.id, [{ selectedIndexes: [0] }]);

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            assert.equal(host.appendEntryCalls.length, 1);
            assert.equal(host.appendEntryCalls[0]!.customType, QUESTION_STATE_ENTRY);

            const snapshot = host.appendEntryCalls[0]!.data as {
                requests: Array<{ id: string }>;
                outbox: Array<{ id: string }>;
            };

            assert.ok(
                snapshot.requests.some((request) => request.id === pending.id),
                "the pending question is in the snapshot",
            );
            assert.deepEqual(
                snapshot.outbox.map((request) => request.id),
                [answered.id],
                "and the settled answer is durable for delivery",
            );
        });

        it("restores a request with its draft from the branch", () => {
            const manager = newManager();
            const original = manager.create(QUESTIONS);
            original.draft.currentIndex = 1;
            original.draft.optionIndex = 2;
            original.draft.answers[0] = { selectedIndexes: [1] };
            original.draft.customDrafts[1] = "half typed";

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch: host.branch }));

            const [restored] = restarted.getPendingRequests();
            assert.ok(restored);
            assert.equal(restored.id, original.id);
            assert.equal(restored.status, "pending");
            assert.equal(restored.draft.currentIndex, 1);
            assert.equal(restored.draft.optionIndex, 2);
            assert.deepEqual(restored.draft.answers[0], { selectedIndexes: [1] });
            assert.equal(restored.draft.customDrafts[1], "half typed");
        });

        it("restores the option payload, previews included", () => {
            const manager = newManager();
            const original = manager.create([
                {
                    question: "Which database?",
                    options: [
                        { label: "Postgres", description: "server", preview: "## JSONB" },
                        { label: "SQLite" },
                    ],
                },
            ]);

            const host = createFakePiHost(() => undefined);
            manager.persist(host.api);

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch: host.branch }));

            // The preview pane has to survive a restart with the rest of the question.
            assert.deepEqual(
                restarted.getPendingRequests()[0]!.questions[0],
                original.questions[0],
            );
        });

        it("normalizes a stored draft that does not line up with the questions", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);

            const branch = branchWith({
                requests: [
                    {
                        ...request,
                        draft: {
                            currentIndex: 99,
                            optionIndex: -3,
                            answers: "broken",
                            customDrafts: null,
                        },
                    },
                ],
                outbox: [],
            });

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch }));

            const [restored] = restarted.getPendingRequests();
            assert.ok(restored);
            assert.equal(restored.draft.currentIndex, restored.questions.length);
            assert.equal(restored.draft.optionIndex, 0);
            assert.deepEqual(restored.draft.answers, [undefined, undefined]);
            assert.deepEqual(restored.draft.customDrafts, [undefined, undefined]);
        });

        it("keeps the newest snapshot when the branch holds several", () => {
            const manager = newManager();
            const stale = manager.create([{ question: "Stale" }]);
            const latest = manager.create([{ question: "Latest" }]);

            const branch: FakeBranchEntry[] = [
                {
                    type: "custom",
                    customType: QUESTION_STATE_ENTRY,
                    data: { requests: [stale], outbox: [] },
                },
                {
                    type: "custom",
                    customType: QUESTION_STATE_ENTRY,
                    data: { requests: [latest], outbox: [] },
                },
            ];

            const restarted = newManager();
            restarted.restore(createFakeContext({ branch }));

            assert.deepEqual(
                restarted.getPendingRequests().map((request) => request.id),
                [latest.id],
            );
        });

        it("ignores unrelated custom entries and malformed snapshots", () => {
            const manager = newManager();

            manager.restore(
                createFakeContext({
                    branch: [
                        {
                            type: "custom",
                            customType: "something-else",
                            data: { requests: [{ id: "x", questions: [] }], outbox: [] },
                        },
                        {
                            type: "custom",
                            customType: QUESTION_STATE_ENTRY,
                            data: { requests: "broken", outbox: [] },
                        },
                    ],
                }),
            );

            assert.deepEqual(manager.getPendingRequests(), []);
        });

        it("ignores a snapshot that does not match the current schema", () => {
            const request = newManager().create(QUESTIONS);
            const malformed: unknown[] = [
                { requests: [request] },
                { outbox: [request] },
                { requests: "broken", outbox: [] },
                { requests: [], outbox: null },
            ];

            for (const data of malformed) {
                const restarted = newManager();

                restarted.restore(
                    createFakeContext({
                        branch: [{ type: "custom", customType: QUESTION_STATE_ENTRY, data }],
                    }),
                );

                assert.deepEqual(
                    restarted.getPendingRequests(),
                    [],
                    `a snapshot without both collections is not restored: ${JSON.stringify(data)}`,
                );
            }
        });

        it("does not replace a live request with the same id", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            request.draft.answers[0] = { selectedIndexes: [0] };

            const branch = branchWith({
                requests: [
                    { ...request, draft: { ...request.draft, answers: [undefined, undefined] } },
                ],
                outbox: [],
            });

            manager.restore(createFakeContext({ branch }));

            assert.deepEqual(manager.get(request.id)?.draft.answers[0], { selectedIndexes: [0] });
        });

        it("does not write a snapshot equal to the one it last wrote", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            const host = createFakePiHost(() => undefined);

            manager.persist(host.api);
            manager.persist(host.api);

            assert.equal(
                host.appendEntryCalls.length,
                1,
                "an unchanged state is not written twice",
            );

            // Drafts change in place without an event; the comparison still has to see them.
            request.draft.customDrafts[1] = "half typed";
            manager.persist(host.api);

            assert.equal(host.appendEntryCalls.length, 2, "a changed draft is written");
        });

        it("does not write back the state it just restored from the branch", () => {
            const source = newManager();
            source.create(QUESTIONS);
            const branch = branchWith(source.snapshot());
            const manager = newManager();
            const host = createFakePiHost(() => undefined, { branch });

            manager.restore(createFakeContext({ branch }));
            manager.persist(host.api);

            assert.equal(manager.getPendingRequests().length, 1);
            assert.equal(host.appendEntryCalls.length, 0, "the branch already records this state");
        });

        it("writes the snapshot again after a write that failed", () => {
            const manager = newManager();
            manager.create(QUESTIONS);
            const host = createFakePiHost(() => undefined);
            const appendEntry = host.api.appendEntry;

            host.api.appendEntry = () => {
                throw new Error("session is read-only");
            };
            assert.throws(() => manager.persist(host.api), /read-only/);

            host.api.appendEntry = appendEntry;
            manager.persist(host.api);

            assert.equal(
                host.appendEntryCalls.length,
                1,
                "the failed snapshot is written once the session accepts it",
            );
        });

        it("keeps only the delivery fields of a settled request", () => {
            const manager = newManager();
            const question: AskQuestion = {
                header: "Storage",
                question: "Which database?",
                displayText: "DISPLAY_SENTINEL",
                multiSelect: true,
                options: [
                    { label: "Postgres", description: "server", preview: "PREVIEW_SENTINEL" },
                    { label: "SQLite" },
                ],
            };
            const answered = manager.create([question]);
            const skipped = manager.create([question]);

            manager.submit(answered.id, [{ selectedIndexes: [0] }]);
            manager.skip(skipped.id);

            const expected = [
                {
                    header: "Storage",
                    question: "Which database?",
                    options: [{ label: "Postgres" }, { label: "SQLite" }],
                },
            ];
            const actual = manager.snapshot().outbox.map((request) => request.questions);

            assert.deepEqual(actual, [expected, expected]);
        });

        it("restores a settled request from an older snapshot with only its delivery fields", () => {
            const branch = branchWith({
                requests: [],
                outbox: [
                    {
                        id: "settled-1",
                        createdAt: 1,
                        settledAt: 2,
                        status: "answered",
                        questions: [
                            {
                                header: "Storage",
                                question: "Which database?",
                                displayText: "DISPLAY_SENTINEL",
                                options: [
                                    { label: "Postgres", preview: "PREVIEW_SENTINEL" },
                                    { label: "SQLite" },
                                ],
                            },
                        ],
                        draft: {
                            currentIndex: 0,
                            optionIndex: 0,
                            answers: [undefined],
                            customDrafts: [undefined],
                        },
                        answers: [{ selectedIndexes: [0] }],
                    },
                ],
            });
            const manager = newManager();

            manager.restore(createFakeContext({ branch }));

            const expected = [
                {
                    header: "Storage",
                    question: "Which database?",
                    options: [{ label: "Postgres" }, { label: "SQLite" }],
                },
            ];
            const actual = manager.get("settled-1")?.questions;

            assert.deepEqual(actual, expected);
        });

        it("clears every request including settled ones", () => {
            const manager = newManager();
            const request = manager.create(QUESTIONS);
            manager.skip(request.id);

            manager.clearAll();

            assert.deepEqual(manager.getPendingRequests(), []);
            assert.equal(manager.get(request.id), undefined);
        });
    });

    describe("listener errors", () => {
        it("reports a failing listener and keeps the others running", () => {
            const manager = newManager();
            const reported: Array<{ error: unknown; event: QuestionManagerEvent }> = [];
            const seen: QuestionManagerEvent[] = [];

            manager.subscribe(
                () => {
                    throw new Error("snapshot failed");
                },
                (error, event) => reported.push({ error, event }),
            );
            manager.subscribe((event) => seen.push(event));

            const request = manager.create([{ question: "First" }]);

            assert.equal(reported.length, 1, "the failure is not silent");
            assert.equal((reported[0]!.error as Error).message, "snapshot failed");
            assert.deepEqual(reported[0]!.event, { type: "request-created", id: request.id });
            assert.deepEqual(
                seen,
                [{ type: "request-created", id: request.id }],
                "a later listener still runs",
            );
        });

        it("keeps going when the reporter itself throws", () => {
            const manager = newManager();
            const seen: QuestionManagerEvent[] = [];

            manager.subscribe(
                () => {
                    throw new Error("snapshot failed");
                },
                () => {
                    throw new Error("notify failed");
                },
            );
            manager.subscribe((event) => seen.push(event));

            const request = manager.create([{ question: "First" }]);

            assert.deepEqual(seen, [{ type: "request-created", id: request.id }]);
        });
    });
});
