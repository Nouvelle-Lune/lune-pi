import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { installCompaction } from "../../src/index.ts";
import type { CompactionController } from "../../src/compaction-controller.ts";
import type { CompactionOptions, CompactionPolicy, JevOptions } from "../../src/options.ts";
import { policy as defaultPolicy } from "./fixtures.ts";

/** A classification request decoded from the wire payload the System One client actually sent. */
export interface SystemOneRequest {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly model: string;
    readonly state: Record<string, unknown>;
    readonly questions: Record<string, { type?: string }>;
    readonly raw: unknown;
}

/** A request whose HTTP response has not been written yet, so a test can hold it pending or abort it. */
export interface PendingSystemOneRequest {
    readonly request: SystemOneRequest;
    /** Resolves once the client has disconnected before the response was written. */
    readonly aborted: Promise<void>;
    respond(body: unknown, status?: number): void;
    fail(status: number, body?: string): void;
}

export type SystemOneResponder = (pending: PendingSystemOneRequest) => void | Promise<void>;

export interface SystemOneSimulator {
    readonly baseUrl: string;
    readonly requests: readonly SystemOneRequest[];
    /**
     * Responder/decoding exceptions the fixture captured. The host turns a non-empty list into a test
     * failure after cleanup so a broken fixture can never masquerade as an accepted "network failure".
     */
    readonly fixtureErrors: readonly unknown[];
    setResponder(responder: SystemOneResponder): void;
    close(): Promise<void>;
}

/** Wire answers for every question in a request, mapped to the System One `noul` type. */
export function systemOneAnswers(
    request: SystemOneRequest,
    probability: number | ((id: string) => number),
): unknown {
    const resolve = typeof probability === "function" ? probability : () => probability;
    return {
        answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, { type: "noul", noul: resolve(id) }]),
        ),
        usage: { input_tokens: 11, output_tokens: 7 },
    };
}

function describeWireValue(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `${typeof value} ${JSON.stringify(value) ?? ""}`.trim();
}

/** Strictly decode the wire payload; a mistyped model/state/questions is a bug, never coerced. */
function decodeSystemOnePayload(body: unknown): {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, { type?: string }>;
} {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error(
            `System One payload must be a JSON object, received ${describeWireValue(body)}`,
        );
    }
    const record = body as Record<string, unknown>;
    if (typeof record.model !== "string" || record.model.length === 0) {
        throw new Error(
            `System One payload model must be a non-empty string, received ${describeWireValue(record.model)}`,
        );
    }
    if (record.state === null || typeof record.state !== "object" || Array.isArray(record.state)) {
        throw new Error(
            `System One payload state must be an object, received ${describeWireValue(record.state)}`,
        );
    }
    if (
        record.questions === null ||
        typeof record.questions !== "object" ||
        Array.isArray(record.questions)
    ) {
        throw new Error(
            `System One payload questions must be an object, received ${describeWireValue(record.questions)}`,
        );
    }
    return {
        model: record.model,
        state: record.state as Record<string, unknown>,
        questions: record.questions as Record<string, { type?: string }>,
    };
}

/** Node HTTP System One simulator on a random 127.0.0.1 port; never touches a real classifier. */
export async function startSystemOneSimulator(): Promise<SystemOneSimulator> {
    const requests: SystemOneRequest[] = [];
    const sockets = new Set<Socket>();
    const errors: unknown[] = [];
    const recordError = (error: unknown): void => {
        errors.push(error);
    };
    let responder: SystemOneResponder = (pending) => {
        pending.respond(systemOneAnswers(pending.request, 0));
    };
    const server: Server = createServer((request, response) => {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            raw += chunk;
        });
        request.on("end", () => {
            let responded = false;
            const finish = (write: () => void): void => {
                if (responded) return;
                responded = true;
                write();
            };
            let decoded: SystemOneRequest;
            try {
                const body = JSON.parse(raw) as unknown;
                const parsed = decodeSystemOnePayload(body);
                decoded = {
                    url: request.url ?? "",
                    authorization: request.headers.authorization,
                    model: parsed.model,
                    state: parsed.state,
                    questions: parsed.questions,
                    raw: body,
                };
            } catch (error) {
                // A malformed wire payload is a production bug: destroy the response and surface the cause.
                recordError(error);
                finish(() => response.destroy());
                return;
            }
            requests.push(decoded);
            let settleAbort!: () => void;
            const aborted = new Promise<void>((resolve) => {
                settleAbort = resolve;
            });
            const settle = (): void => {
                if (!responded) settleAbort();
            };
            response.on("close", settle);
            // A client abort closes the socket without writing a response; detecting that lets a test
            // observe cancellation instead of waiting on a request that will never complete.
            request.on("close", settle);
            const pending: PendingSystemOneRequest = {
                request: decoded,
                aborted,
                respond: (answer, status = 200) =>
                    finish(() => {
                        const text = JSON.stringify(answer);
                        response.writeHead(status, {
                            "content-type": "application/json",
                            "content-length": Buffer.byteLength(text),
                        });
                        response.end(text);
                    }),
                fail: (status, body) =>
                    finish(() => {
                        const text = body ?? "simulated failure";
                        response.writeHead(status, { "content-type": "text/plain" });
                        response.end(text);
                    }),
            };
            try {
                // A synchronous throw and a rejected promise are both unexpected fixture failures; record
                // the original error and fail the test after cleanup instead of hiding it as a transport error.
                Promise.resolve(responder(pending)).catch((error) => {
                    recordError(error);
                    finish(() => response.destroy());
                });
            } catch (error) {
                recordError(error);
                finish(() => response.destroy());
            }
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        fixtureErrors: errors,
        setResponder: (next) => {
            responder = next;
        },
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export interface JevHostOptions {
    readonly messages: readonly AgentMessage[];
    readonly jev: JevOptions | ((baseUrl: string) => JevOptions);
    readonly contextWindow?: number;
    readonly policy?: CompactionPolicy;
    readonly keepRecentTokens?: number;
}

export interface JevHost {
    readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    readonly controller: CompactionController;
    readonly faux: ReturnType<typeof fauxProvider>;
    readonly sessionManager: SessionManager;
    readonly simulator: SystemOneSimulator;
    /** Number of requests routed through the registered classifier adapter. */
    registryJevCalls(): number;
    captureContext(): ExtensionContext;
    dispose(): Promise<void>;
}

/**
 * Starts a real Pi SDK host whose Jev classifier is the local System One simulator. The runtime uses
 * a temporary auth file and no models file so no user-global configuration is read.
 */
export async function startJevHost(options: JevHostOptions): Promise<JevHost> {
    const simulator = await startSystemOneSimulator();
    const dir = mkdtempSync(join(tmpdir(), "lune-jev-"));
    const faux = fauxProvider({
        provider: "faux-summary",
        models: [{ id: "sum-1", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 }],
    });
    const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    let registryJevCalls = 0;
    runtime.registerProvider("registry-jev", {
        apiKey: "fake-test-key",
        baseUrl: simulator.baseUrl,
        classifiers: {
            "typesafe-system-one": {
                classify: async (model, context, options) => {
                    registryJevCalls++;
                    return classify(model, context, options);
                },
            },
        },
        models: [
            {
                type: "classifier",
                id: "jev-latest",
                name: "jev-latest",
                api: "typesafe-system-one",
                baseUrl: simulator.baseUrl,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: options.contextWindow ?? 7_000,
            },
        ],
    });

    const sessionManager = SessionManager.inMemory(dir);
    for (const message of options.messages) sessionManager.appendMessage(message as never);
    const settingsManager = SettingsManager.inMemory({
        compaction: { keepRecentTokens: options.keepRecentTokens ?? 100 },
        retry: { enabled: false },
    });
    const configuration: CompactionOptions = {
        summaryModel: { provider: "faux-summary", id: "sum-1" },
        summaryThinkingLevel: "off",
        policy: options.policy ?? defaultPolicy(),
        jev: typeof options.jev === "function" ? options.jev(simulator.baseUrl) : options.jev,
    };

    let controller!: CompactionController;
    let context: ExtensionContext | undefined;
    const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
            (pi) => {
                pi.on("session_start", (_event, ctx) => {
                    context = ctx;
                });
            },
            (pi) => {
                controller = installCompaction(pi, () => configuration);
            },
        ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: runtime,
        model: faux.getModel(),
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: [],
    });
    await session.bindExtensions({ mode: "print" });
    return {
        session,
        controller,
        faux,
        sessionManager,
        simulator,
        registryJevCalls: () => registryJevCalls,
        captureContext: () => {
            assert.ok(context, "the host must expose an extension context after session_start");
            return context;
        },
        dispose: async () => {
            // Release the session, sockets and temp directory even when cleanup itself fails.
            try {
                session.dispose();
                await simulator.close();
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
            if (simulator.fixtureErrors.length > 0) {
                const causes = simulator.fixtureErrors.map((error) =>
                    error instanceof Error ? error : new Error(String(error)),
                );
                throw new AggregateError(
                    causes,
                    `System One fixture responder produced ${causes.length} unexpected error(s): ${causes.map((cause) => cause.message).join("; ")}`,
                );
            }
        },
    };
}
