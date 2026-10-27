import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type {
    ExtensionContext,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { createDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";

import { DockController } from "../../src/dock-controller.ts";
import { DockStatusSource } from "../../src/dock-status.ts";
import {
    FakeDockUi,
    FakeFooterData,
    assistantEnd,
    assistantMessage,
    assistantStart,
    assistantUpdate,
    createCompactionReader,
    createMainEditor,
    createModel,
    createSessionContext,
    createUsage,
    settle,
} from "../harness.ts";

function createSource(options: { model?: ReturnType<typeof createModel> } = {}) {
    const { ctx, session } = createSessionContext();
    if (options.model) session.model = options.model;
    const footerData = new FakeFooterData();
    const source = new DockStatusSource(createCompactionReader().read);
    return {
        ctx,
        session,
        source,
        tokenSpeed: () => source.collect(ctx, footerData).tokenSpeed,
    };
}

/** A finalized response as Pi's event stream reports it, with the request duration the SDK measured. */
function response(
    output: number,
    durationMs: number | undefined,
    overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
    return assistantMessage(createUsage({ output }), {
        timestamp: 1000,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...overrides,
    });
}

function endOf(message: AssistantMessage): MessageEndEvent {
    return assistantEnd(message);
}

function asMessageEvent<T extends MessageStartEvent | MessageUpdateEvent | MessageEndEvent>(event: {
    type: string;
    message: unknown;
}): T {
    return event as unknown as T;
}

describe("dock token speed source", () => {
    it("reports no rate before the first measurement while the assistant response streams", () => {
        const { ctx, source, tokenSpeed } = createSource();
        assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false });

        const started = source.observeMessage(
            assistantStart(assistantMessage(createUsage({ output: 120 }))),
            ctx,
        );
        const startedSpeed = tokenSpeed();

        const updated = source.observeMessage(
            assistantUpdate(assistantMessage(createUsage({ output: 480 }))),
            ctx,
        );
        const updatedSpeed = tokenSpeed();

        assert.deepEqual(
            { started, startedSpeed, updated, updatedSpeed },
            {
                started: true,
                startedSpeed: { tokensPerSecond: undefined, generating: true },
                updated: true,
                updatedSpeed: { tokensPerSecond: undefined, generating: true },
            },
            "partial usage is not a reliable live token count",
        );
    });

    it("measures the finalized response from output tokens over the whole request duration", () => {
        const cases: [number, number, number][] = [
            [500, 2000, 250],
            [100, 10_000, 10],
            [7, 1000, 7],
        ];

        for (const [output, durationMs, expected] of cases) {
            const { ctx, source, tokenSpeed } = createSource();

            source.observeMessage(endOf(response(output, durationMs)), ctx);

            assert.deepEqual(
                tokenSpeed(),
                { tokensPerSecond: expected, generating: false },
                `${output} tokens in ${durationMs}ms`,
            );
        }
    });

    it("reports an unknown rate when the duration or output cannot produce one", () => {
        const cases: [string, AssistantMessage][] = [
            ["no output", response(0, 1000)],
            ["no duration", response(100, undefined)],
            ["zero duration", response(100, 0)],
            ["negative duration", response(100, -5)],
            ["non-finite duration", response(100, Number.POSITIVE_INFINITY)],
            ["non-finite output", response(Number.NaN, 1000)],
        ];

        for (const [name, message] of cases) {
            const { ctx, source, tokenSpeed } = createSource();

            source.observeMessage(endOf(message), ctx);

            assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false }, name);
        }
    });

    it("measures error and aborted responses by the same numerical rule", () => {
        const cases: [StopReason, number, number | undefined, number | undefined][] = [
            ["error", 250, 1000, 250],
            ["aborted", 250, 1000, 250],
            ["aborted", 250, undefined, undefined],
            ["error", 0, 1000, undefined],
        ];

        for (const [stopReason, output, durationMs, expected] of cases) {
            const { ctx, source, tokenSpeed } = createSource();

            source.observeMessage(endOf(response(output, durationMs, { stopReason })), ctx);

            assert.deepEqual(
                tokenSpeed(),
                { tokensPerSecond: expected, generating: false },
                stopReason,
            );
        }
    });

    it("retains the last measured rate through the next response and an unmeasured end", () => {
        const endings: [string, AssistantMessage][] = [
            ["blank", response(0, 1000, { timestamp: 2000 })],
            ["non-finite", response(Number.NaN, 1000, { timestamp: 2000 })],
            ["cancelled", response(0, undefined, { timestamp: 2000, stopReason: "aborted" })],
        ];

        for (const [name, ending] of endings) {
            const { ctx, source, tokenSpeed } = createSource();
            source.observeMessage(endOf(response(500, 2000, { timestamp: 1000 })), ctx);
            source.observeMessage(
                assistantStart(assistantMessage(createUsage({ output: 120 }), { timestamp: 2000 })),
                ctx,
            );
            const whileStarting = tokenSpeed();
            source.observeMessage(
                assistantUpdate(
                    assistantMessage(createUsage({ output: 480 }), { timestamp: 2000 }),
                ),
                ctx,
            );
            const whileStreaming = tokenSpeed();

            source.observeMessage(endOf(ending), ctx);
            const afterEnd = tokenSpeed();

            assert.deepEqual(
                { whileStarting, whileStreaming, afterEnd },
                {
                    whileStarting: { tokensPerSecond: 250, generating: true },
                    whileStreaming: { tokensPerSecond: 250, generating: true },
                    afterEnd: { tokensPerSecond: 250, generating: false },
                },
                name,
            );
        }
    });

    it("replaces the retained rate when the next response has a valid measurement", () => {
        const { ctx, source, tokenSpeed } = createSource();
        source.observeMessage(endOf(response(500, 2000, { timestamp: 1000 })), ctx);
        source.observeMessage(
            assistantStart(assistantMessage(createUsage(), { timestamp: 2000 })),
            ctx,
        );

        source.observeMessage(endOf(response(300, 1000, { timestamp: 2000 })), ctx);

        const actual = tokenSpeed();
        assert.deepEqual(actual, { tokensPerSecond: 300, generating: false });
    });

    it("does not carry the rate into a response for another selected model", () => {
        const { ctx, session, source, tokenSpeed } = createSource();
        source.observeMessage(endOf(response(500, 2000, { timestamp: 1000 })), ctx);
        session.model = createModel({ provider: "anthropic", id: "claude-other" });

        source.observeMessage(
            assistantStart(assistantMessage(createUsage(), { timestamp: 2000 })),
            ctx,
        );
        const whileStarting = tokenSpeed();
        source.observeMessage(endOf(response(0, 1000, { timestamp: 2000 })), ctx);
        const afterEnd = tokenSpeed();

        assert.deepEqual(
            { whileStarting, afterEnd },
            {
                whileStarting: { tokensPerSecond: undefined, generating: true },
                afterEnd: { tokensPerSecond: undefined, generating: false },
            },
        );
    });

    it("keeps the latest rate after the response ends across collected frames", () => {
        const { ctx, source, tokenSpeed } = createSource();
        source.observeMessage(endOf(response(500, 2000)), ctx);

        const first = tokenSpeed();
        const second = tokenSpeed();

        assert.deepEqual(first, { tokensPerSecond: 250, generating: false });
        assert.deepEqual(second, first);
    });

    it("ignores events for messages that are not assistant responses", () => {
        const { ctx, source, tokenSpeed } = createSource();
        const user = { role: "user", content: "hello", timestamp: 0 };
        const toolResult = {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "shell",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 0,
        };

        const observed = [
            source.observeMessage(asMessageEvent({ type: "message_start", message: user }), ctx),
            source.observeMessage(
                asMessageEvent({ type: "message_update", message: toolResult }),
                ctx,
            ),
            source.observeMessage(asMessageEvent({ type: "message_end", message: user }), ctx),
        ];
        const untouched = tokenSpeed();

        source.observeMessage(endOf(response(500, 2000)), ctx);
        source.observeMessage(asMessageEvent({ type: "message_end", message: user }), ctx);
        const retained = tokenSpeed();

        assert.deepEqual(
            { observed, untouched, retained },
            {
                observed: [false, false, false],
                untouched: { tokensPerSecond: undefined, generating: false },
                retained: { tokensPerSecond: 250, generating: false },
            },
        );
    });

    it("measures the selected virtual model although the response reports a routed physical one", () => {
        const { ctx, session, source, tokenSpeed } = createSource({
            model: createModel({ provider: "anthropic", id: "claude-opus-selected" }),
        });
        const routed = response(300, 1000, {
            provider: "openai",
            model: "gpt-routed-physical",
        });

        source.observeMessage(assistantStart(routed), ctx);
        source.observeMessage(assistantUpdate(routed), ctx);
        source.observeMessage(endOf(routed), ctx);

        const measured = tokenSpeed();
        const selected = { provider: session.model?.provider, model: session.model?.id };

        assert.deepEqual(measured, { tokensPerSecond: 300, generating: false });
        assert.deepEqual(selected, { provider: "anthropic", model: "claude-opus-selected" });
    });

    it("hides a rate for a selection that changed during the response", () => {
        const { ctx, session, source, tokenSpeed } = createSource({
            model: createModel({ provider: "anthropic", id: "claude-opus-selected" }),
        });
        const routed = response(300, 1000, {
            provider: "openai",
            model: "gpt-routed-physical",
        });
        source.observeMessage(assistantStart(routed), ctx);
        assert.equal(tokenSpeed().generating, true);

        session.model = createModel({ provider: "anthropic", id: "claude-sonnet-other" });
        const afterManualChange = tokenSpeed();
        source.observeMessage(assistantUpdate(routed), ctx);
        source.observeMessage(endOf(routed), ctx);
        const afterEnd = tokenSpeed();

        assert.deepEqual(
            { afterManualChange, afterEnd },
            {
                afterManualChange: { tokensPerSecond: undefined, generating: false },
                afterEnd: { tokensPerSecond: undefined, generating: false },
            },
            "a later event must not adopt the newly selected model",
        );
    });

    it("hides the rate when the session or the UI owner changes", () => {
        const first = createSource();
        first.source.observeMessage(endOf(response(500, 2000)), first.ctx);

        const otherSession = createSessionContext({ ui: first.ctx.ui });
        const otherSessionSpeed = first.source.collect(
            otherSession.ctx,
            new FakeFooterData(),
        ).tokenSpeed;
        const otherUiSpeed = first.source.collect(
            { ...first.ctx, ui: { setStatus: () => undefined } } as unknown as ExtensionContext,
            new FakeFooterData(),
        ).tokenSpeed;

        assert.deepEqual(
            { otherSessionSpeed, otherUiSpeed },
            {
                otherSessionSpeed: { tokensPerSecond: undefined, generating: false },
                otherUiSpeed: { tokensPerSecond: undefined, generating: false },
            },
        );
    });

    it("clears the rate on demand", () => {
        const { ctx, source, tokenSpeed } = createSource();
        source.observeMessage(endOf(response(500, 2000)), ctx);

        source.resetTokenSpeed();

        assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false });
    });
});

describe("dock controller token speed", () => {
    function attachedController() {
        const editor = createMainEditor();
        const ui = new FakeDockUi(editor);
        const { ctx, session } = createSessionContext({ ui });
        const controller = new DockController(
            createDockRegistry(),
            new DockStatusSource(createCompactionReader().read),
        );
        controller.attach(ctx);
        return {
            ui,
            ctx,
            session,
            controller,
            tokenSpeed: () => controller.collectStatus()?.tokenSpeed,
        };
    }

    it("accepts assistant events from its own UI and session and requests a redraw", () => {
        const { ui, ctx, controller, tokenSpeed } = attachedController();
        const before = ui.tui.renderRequests;

        controller.observeMessage(assistantStart(assistantMessage(createUsage())), ctx);
        const started = tokenSpeed();
        const renders = ui.tui.renderRequests - before;

        controller.observeMessage(endOf(response(500, 2000)), ctx);
        const ended = tokenSpeed();

        assert.deepEqual(
            { started, ended, renders },
            {
                started: { tokensPerSecond: undefined, generating: true },
                ended: { tokensPerSecond: 250, generating: false },
                renders: 1,
            },
        );
    });

    it("ignores events from another UI or session without redrawing", () => {
        const { ui, ctx, controller, tokenSpeed } = attachedController();
        const otherSession = createSessionContext({ ui }).ctx;
        const otherUi = {
            ...ctx,
            ui: new FakeDockUi(createMainEditor()),
        } as unknown as ExtensionContext;
        const before = ui.tui.renderRequests;

        controller.observeMessage(endOf(response(500, 2000)), otherSession);
        controller.observeMessage(endOf(response(500, 2000)), otherUi);

        assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false });
        assert.equal(ui.tui.renderRequests, before);
    });

    it("clears the rate and invalidates when reset", async () => {
        const { ui, ctx, controller, tokenSpeed } = attachedController();
        controller.observeMessage(endOf(response(500, 2000)), ctx);
        const before = ui.tui.renderRequests;

        controller.resetTokenSpeed();
        await settle();

        assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false });
        assert.ok(ui.tui.renderRequests > before);
    });

    it("drops the rate when the dock detaches", () => {
        const { ctx, controller, tokenSpeed } = attachedController();
        controller.observeMessage(endOf(response(500, 2000)), ctx);
        assert.equal(tokenSpeed()?.tokensPerSecond, 250);

        controller.detach();
        controller.attach(ctx);

        assert.deepEqual(tokenSpeed(), { tokensPerSecond: undefined, generating: false });
    });
});
