import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface EndpointRequest {
    method: string;
    /** Path and query, for example `/v1/models?limit=1000`. */
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
    /** The body parsed as JSON. Throws when the body is not JSON. */
    json(): unknown;
}

export interface EndpointReply {
    /** HTTP status. Default 200. */
    status?: number;
    headers?: Record<string, string>;
    /** Reply body as JSON. Ignored when `body` or `chunks` is set. */
    json?: unknown;
    /** Raw reply body. */
    body?: string;
    /** Pieces of a streamed reply, such as SSE events, written in order. */
    chunks?: string[];
}

export type EndpointHandler = (request: EndpointRequest) => EndpointReply | Promise<EndpointReply>;

export interface FakeEndpoint {
    /** Origin without a trailing slash, for example `http://127.0.0.1:52344`. */
    url: string;
    /** Requests in arrival order. */
    requests: EndpointRequest[];
    close(): Promise<void>;
}

function send(response: ServerResponse, reply: EndpointReply): void {
    response.statusCode = reply.status ?? 200;
    const headers = { ...reply.headers };
    if (reply.json !== undefined) headers["content-type"] ??= "application/json";
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (reply.chunks) {
        for (const chunk of reply.chunks) response.write(chunk);
        response.end();
        return;
    }
    if (reply.body !== undefined) response.end(reply.body);
    else if (reply.json !== undefined) response.end(JSON.stringify(reply.json));
    else response.end();
}

/**
 * A real HTTP server on loopback. The handler answers every request and the endpoint records what
 * it received, so a test can assert on the request path, headers and body.
 */
export async function startEndpoint(handler: EndpointHandler): Promise<FakeEndpoint> {
    const requests: EndpointRequest[] = [];
    const server = createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const request: EndpointRequest = {
                method: incoming.method ?? "GET",
                url: incoming.url ?? "/",
                headers: incoming.headers,
                body,
                json(): unknown {
                    return JSON.parse(body);
                },
            };
            requests.push(request);
            Promise.resolve(handler(request)).then(
                (reply) => send(response, reply),
                () => {
                    response.statusCode = 500;
                    response.end("endpoint handler failed");
                },
            );
        });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}
