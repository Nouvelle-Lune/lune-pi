import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { MemoryClient } from "../../src/client/memory-client.ts";
import { MEMORY_CONTEXT_TAG } from "../../src/core/types.ts";
import { MCP_TOOLS } from "../../src/integrations/mcp.ts";
import {
    createMemoryTools,
    createPiExtension,
    l1SectionText,
    piToolSchema,
} from "../../src/pi-extension.ts";
import { sandbox } from "../harness/cli.ts";

interface L1Call {
    cwd?: string | null;
    harness?: string | null;
    sessionId?: string | null;
    announceSession?: boolean;
}

interface Fake {
    client: MemoryClient;
    l1Calls: L1Call[];
    locationCalls: Array<string | null | undefined>;
    closed: () => number;
    /** Next l1 answers. A function result is awaited. */
    answers: Array<() => Promise<{ text: string }>>;
}

function fakeClient(configPath: string): Fake {
    const l1Calls: L1Call[] = [];
    const locationCalls: Array<string | null | undefined> = [];
    const answers: Fake["answers"] = [];
    let closed = 0;
    const client = {
        paths: { config: configPath },
        l1: async (request: L1Call) => {
            l1Calls.push(request);
            const next = answers.shift();
            if (!next) throw new Error("no answer prepared");
            return next();
        },
        location: async (cwd?: string | null) => {
            locationCalls.push(cwd);
            throw new Error("stop here");
        },
        close: async () => {
            closed += 1;
        },
    } as unknown as MemoryClient;
    return { client, l1Calls, locationCalls, closed: () => closed, answers };
}

// Pi events and tool results are loosely typed in this fake.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (event: any, ctx: ExtensionContext) => unknown;

function fakePi() {
    const handlers = new Map<string, Handler>();
    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    const pi = {
        on: (name: string, handler: Handler) => handlers.set(name, handler),
        registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    } as unknown as ExtensionAPI;
    return { pi, handlers, tools };
}

function fakeCtx(cwd = "/work/project", sessionId: string | null = "session-1") {
    const notices: Array<{ message: string; level: string | undefined }> = [];
    const ctx = {
        cwd,
        sessionManager: { getSessionId: () => sessionId ?? undefined },
        ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    } as unknown as ExtensionContext;
    return { ctx, notices };
}

function beforeStartEvent(): { systemPromptOptions: { sections: Record<string, string> } } {
    return { systemPromptOptions: { sections: {} } };
}

function setup(t: TestContext, options: { piEnabled?: boolean } = {}) {
    const box = sandbox(t);
    if (options.piEnabled) {
        writeFileSync(
            box.paths.config,
            JSON.stringify({ autoStart: false, harnesses: { pi: { enabled: true } } }),
        );
    }
    const fake = fakeClient(box.paths.config);
    const host = fakePi();
    createPiExtension({ client: fake.client })(host.pi);
    const handler = (name: string): Handler => {
        const found = host.handlers.get(name);
        assert.ok(found, `${name} handler is registered`);
        return found;
    };
    return { fake, host, handler };
}

const WRAPPED = `<${MEMORY_CONTEXT_TAG}>\nProject facts\n</${MEMORY_CONTEXT_TAG}>`;

describe("l1SectionText", () => {
    it("strips the wrapper tag and surrounding whitespace", () => {
        assert.equal(l1SectionText(`\n${WRAPPED}\n`), "Project facts");
    });

    it("keeps text that has no wrapper", () => {
        assert.equal(l1SectionText("  plain text \n"), "plain text");
    });

    it("returns an empty string for an empty wrapper", () => {
        assert.equal(l1SectionText(`<${MEMORY_CONTEXT_TAG}></${MEMORY_CONTEXT_TAG}>`), "");
    });
});

describe("piToolSchema", () => {
    it("removes session_id and cwd from properties and required, and keeps the rest", () => {
        const actual = piToolSchema({
            type: "object",
            properties: { query: { type: "string" }, cwd: {}, session_id: {} },
            required: ["query", "cwd", "session_id"],
            additionalProperties: false,
        });

        assert.deepEqual(actual, {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
        });
    });

    it("adds no required list when the schema had none", () => {
        const actual = piToolSchema({ type: "object", properties: { cwd: {} } });

        assert.equal("required" in actual, false);
        assert.deepEqual(actual.properties, {});
    });
});

describe("memory tools", () => {
    it("registers one Pi tool for each MCP tool without the session arguments", (t) => {
        const { host } = setup(t);

        const actual = host.tools.map((tool) => tool.name);

        assert.deepEqual(
            actual,
            MCP_TOOLS.map((tool) => tool.name),
        );
        for (const tool of host.tools as unknown as Array<{ parameters: any }>) {
            assert.equal("cwd" in tool.parameters.properties, false);
            assert.equal("session_id" in tool.parameters.properties, false);
        }
    });

    it("fills cwd from the session context when a tool runs", async () => {
        const fake = fakeClient("/unused");
        const tools = createMemoryTools(fake.client);
        const location = tools.find((tool) => tool.name === "memory_location");
        assert.ok(location);
        const { ctx } = fakeCtx("/work/here");

        const result = await location.execute(
            "call-1",
            {},
            undefined,
            undefined,
            ctx as unknown as Parameters<typeof location.execute>[4],
        );

        assert.deepEqual(fake.locationCalls, ["/work/here"]);
        assert.equal(result.isError, true, "the backend error becomes an error result");
        const first = result.content[0];
        assert.ok(first && first.type === "text");
        assert.match(first.text, /stop here/u);
    });
});

describe("L1 injection", () => {
    it("fetches L1 at session_start and puts it in the section before the agent starts", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(async () => ({ text: WRAPPED }));
        const { ctx } = fakeCtx("/work/project", "session-1");

        await handler("session_start")({}, ctx);
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.deepEqual(fake.l1Calls, [
            { cwd: "/work/project", harness: "pi", sessionId: "session-1", announceSession: false },
        ]);
        assert.equal(event.systemPromptOptions.sections[MEMORY_CONTEXT_TAG], "Project facts");
    });

    it("keeps the same section text on later turns", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(async () => ({ text: WRAPPED }));
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);

        const first = beforeStartEvent();
        const second = beforeStartEvent();
        await handler("before_agent_start")(first, ctx);
        await handler("before_agent_start")(second, ctx);

        assert.equal(fake.l1Calls.length, 1);
        assert.deepEqual(second.systemPromptOptions.sections, first.systemPromptOptions.sections);
    });

    it("fetches L1 again at session_compact", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(
            async () => ({ text: "first" }),
            async () => ({ text: "second" }),
        );
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("before_agent_start")(beforeStartEvent(), ctx);

        await handler("session_compact")({}, ctx);
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.equal(fake.l1Calls.length, 2);
        assert.equal(event.systemPromptOptions.sections[MEMORY_CONTEXT_TAG], "second");
    });

    it("sets no section when L1 is empty", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(async () => ({ text: "" }));
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);

        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.deepEqual(event.systemPromptOptions.sections, {});
    });

    it("sends a null session id when Pi has none", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(async () => ({ text: "x" }));
        const { ctx } = fakeCtx("/work", null);

        await handler("session_start")({}, ctx);

        assert.equal(fake.l1Calls[0]?.sessionId, null);
    });

    it("waits at most 10 seconds for a slow L1 and then leaves it out", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { fake, handler } = setup(t);
        fake.answers.push(() => new Promise(() => {}));
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);

        const event = beforeStartEvent();
        let finished = false;
        const waiting = Promise.resolve(handler("before_agent_start")(event, ctx)).then(() => {
            finished = true;
        });
        t.mock.timers.tick(9_999);
        await Promise.resolve();
        await Promise.resolve();
        const earlyFinish = finished;
        t.mock.timers.tick(1);
        await waiting;

        assert.equal(earlyFinish, false);
        assert.equal(finished, true);
        assert.deepEqual(event.systemPromptOptions.sections, {});
    });
});

describe("failure handling", () => {
    it("warns once with the error, then goes on without L1", async (t) => {
        const { handler } = setup(t);
        const { ctx, notices } = fakeCtx();

        await handler("session_start")({}, ctx);
        await handler("before_agent_start")(beforeStartEvent(), ctx);
        await handler("session_compact")({}, ctx);
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        const warnings = notices.filter((notice) => notice.level === "warning");
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]?.message ?? "", /^lune-memory: memory context is not available/u);
        assert.match(warnings[0]?.message ?? "", /no answer prepared/u);
        assert.deepEqual(event.systemPromptOptions.sections, {});
    });
});

describe("session hints and shutdown", () => {
    it("tells once that Pi sessions are not imported while the Pi harness is off", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(
            async () => ({ text: "" }),
            async () => ({ text: "" }),
        );
        const { ctx, notices } = fakeCtx();

        await handler("session_start")({}, ctx);
        await handler("session_start")({}, ctx);

        const infos = notices.filter((notice) => notice.level === "info");
        assert.equal(infos.length, 1);
        assert.match(infos[0]?.message ?? "", /lune-memory setup pi/u);
    });

    it("gives no import hint when the Pi harness is on", async (t) => {
        const { fake, handler } = setup(t, { piEnabled: true });
        fake.answers.push(async () => ({ text: "" }));
        const { ctx, notices } = fakeCtx();

        await handler("session_start")({}, ctx);

        assert.deepEqual(notices, []);
    });

    it("closes the client and drops the section at session_shutdown", async (t) => {
        const { fake, handler } = setup(t);
        fake.answers.push(async () => ({ text: "kept?" }));
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("before_agent_start")(beforeStartEvent(), ctx);

        await handler("session_shutdown")({}, ctx);
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.equal(fake.closed(), 1);
        assert.deepEqual(event.systemPromptOptions.sections, {});
    });
});

/** A promise that the test settles by hand, to control the order of L1 answers. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

/** Let the callbacks of settled promises run. */
const flush = () => new Promise<void>((done) => setImmediate(done));

describe("L1 refresh order", () => {
    it("drops an older answer that arrives after a newer one", async (t) => {
        const { fake, handler } = setup(t);
        const older = deferred<{ text: string }>();
        const newer = deferred<{ text: string }>();
        fake.answers.push(
            () => older.promise,
            () => newer.promise,
        );
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("session_compact")({}, ctx);

        newer.resolve({ text: "newer" });
        await flush();
        older.resolve({ text: "older" });
        await flush();
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.equal(fake.l1Calls.length, 2);
        assert.equal(event.systemPromptOptions.sections[MEMORY_CONTEXT_TAG], "newer");
    });

    it("keeps the newer answer when the older one arrives first", async (t) => {
        const { fake, handler } = setup(t);
        const older = deferred<{ text: string }>();
        const newer = deferred<{ text: string }>();
        fake.answers.push(
            () => older.promise,
            () => newer.promise,
        );
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("session_compact")({}, ctx);

        older.resolve({ text: "older" });
        await flush();
        const before = beforeStartEvent();
        const waiting = Promise.resolve(handler("before_agent_start")(before, ctx));
        newer.resolve({ text: "newer" });
        await waiting;

        assert.equal(before.systemPromptOptions.sections[MEMORY_CONTEXT_TAG], "newer");
    });

    it("does not warn about a failure of an older request", async (t) => {
        const { fake, handler } = setup(t);
        const older = deferred<{ text: string }>();
        const newer = deferred<{ text: string }>();
        fake.answers.push(
            () => older.promise,
            () => newer.promise,
        );
        const { ctx, notices } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("session_compact")({}, ctx);

        older.reject(new Error("old failure"));
        await flush();
        newer.resolve({ text: "newer" });
        await flush();

        assert.deepEqual(
            notices.filter((notice) => notice.level === "warning"),
            [],
        );
    });

    it("warns about a failure of the latest request", async (t) => {
        const { fake, handler } = setup(t);
        const latest = deferred<{ text: string }>();
        fake.answers.push(() => latest.promise);
        const { ctx, notices } = fakeCtx();
        await handler("session_start")({}, ctx);

        latest.reject(new Error("latest failure"));
        await flush();

        const warnings = notices.filter((notice) => notice.level === "warning");
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]?.message ?? "", /latest failure/u);
    });

    it("drops an answer that arrives after shutdown", async (t) => {
        const { fake, handler } = setup(t);
        const late = deferred<{ text: string }>();
        fake.answers.push(() => late.promise);
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("session_shutdown")({}, ctx);

        late.resolve({ text: "late" });
        await flush();
        const event = beforeStartEvent();
        await handler("before_agent_start")(event, ctx);

        assert.deepEqual(event.systemPromptOptions.sections, {});
    });

    it("does not warn about a failure that arrives after shutdown", async (t) => {
        const { fake, handler } = setup(t);
        const late = deferred<{ text: string }>();
        fake.answers.push(() => late.promise);
        const { ctx, notices } = fakeCtx();
        await handler("session_start")({}, ctx);
        await handler("session_shutdown")({}, ctx);

        late.reject(new Error("late failure"));
        await flush();

        assert.deepEqual(
            notices.filter((notice) => notice.level === "warning"),
            [],
        );
    });

    it("waits for a refresh that starts while an earlier turn is waiting", async (t) => {
        const { fake, handler } = setup(t);
        const first = deferred<{ text: string }>();
        const second = deferred<{ text: string }>();
        fake.answers.push(
            () => first.promise,
            () => second.promise,
        );
        const { ctx } = fakeCtx();
        await handler("session_start")({}, ctx);
        const early = beforeStartEvent();
        const earlyTurn = Promise.resolve(handler("before_agent_start")(early, ctx));
        await handler("session_compact")({}, ctx);
        first.resolve({ text: "first" });
        await earlyTurn;

        const later = beforeStartEvent();
        const laterTurn = Promise.resolve(handler("before_agent_start")(later, ctx));
        second.resolve({ text: "second" });
        await laterTurn;

        assert.deepEqual(early.systemPromptOptions.sections, {});
        assert.equal(later.systemPromptOptions.sections[MEMORY_CONTEXT_TAG], "second");
    });
});
