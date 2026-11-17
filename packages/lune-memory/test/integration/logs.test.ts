import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { startDaemon, type RunningDaemon } from "../../src/daemon/run.ts";
import { MemoryService, type ServiceEvent } from "../../src/service.ts";
import {
    createTestEnv,
    openTestDaemon,
    TEST_TOKEN,
    type TestDaemon,
    type TestEnv,
} from "../harness/daemon.ts";
import { jsonl, makeTempDir, removeDir, writeText } from "../harness/ingest.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

describe("daemon log snapshot", () => {
    let env: TestEnv;
    let service: MemoryService;
    let logPath: string;

    beforeEach(() => {
        env = createTestEnv();
        service = MemoryService.open(env.home);
        logPath = join(env.home, "logs", "daemon.log");
    });

    afterEach(() => {
        service.close();
        env.cleanup();
    });

    it("returns an empty snapshot when no log exists", () => {
        const actual = service.logs();

        assert.equal(actual.path, logPath);
        assert.deepEqual(actual.lines, []);
        assert.equal(actual.truncated, false);
    });

    it("appends a timestamped line and emits a log event per message", () => {
        const first = "Import finished";
        const second = "Views are out of date";
        const expectedMessages = [first, second];
        const events: ServiceEvent[] = [];
        const stop = service.on((event) => events.push(event));
        try {
            service.log(first);
            service.log(second);
        } finally {
            stop();
        }

        const messages = events
            .filter((event) => event.type === "log")
            .map((event) => event.data.message);
        assert.deepEqual(messages, expectedMessages);

        const actual = service.logs();
        assert.equal(actual.truncated, false);
        assert.equal(actual.lines.length, expectedMessages.length);
        for (const [index, message] of expectedMessages.entries()) {
            const line = actual.lines[index] ?? "";
            assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u);
            assert.ok(line.endsWith(` ${message}`));
        }
    });

    it("persists explicit level and source labels on every multiline line", () => {
        const events: ServiceEvent[] = [];
        const stop = service.on((event) => events.push(event));
        try {
            service.log("plain message");
            service.log("first line\nsecond line", { level: "warn", source: "views" });
        } finally {
            stop();
        }

        const actual = service.logs();
        const expected = [
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[DAEMON\] plain message$/u,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[WARN\] \[VIEWS\] first line$/u,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[WARN\] \[VIEWS\] second line$/u,
        ];
        assert.equal(actual.lines.length, expected.length);
        for (const [index, pattern] of expected.entries()) {
            assert.match(actual.lines[index] ?? "", pattern);
        }

        const data = events.filter((event) => event.type === "log").map((event) => event.data);
        assert.deepEqual(
            data.map((entry) => entry.message),
            ["plain message", "first line\nsecond line"],
        );
        assert.deepEqual(
            data.map((entry) => ({ level: entry.level, source: entry.source })),
            [
                { level: "info", source: "daemon" },
                { level: "warn", source: "views" },
            ],
        );
        assert.deepEqual(
            data.map((entry) => entry.error),
            [undefined, undefined],
        );
    });

    it("returns all 200 lines without flagging truncation at the line boundary", () => {
        const history = Array.from(
            { length: 200 },
            (_, index) => `${TIMESTAMP} line-${String(index).padStart(3, "0")}`,
        );
        mkdirSync(join(env.home, "logs"), { recursive: true });
        writeFileSync(logPath, `${history.join("\n")}\n`);

        const actual = service.logs();

        assert.deepEqual(actual.lines, history);
        assert.equal(actual.truncated, false);
    });

    it("returns the latest 200 lines in chronological order and flags the cut", () => {
        const history = Array.from(
            { length: 250 },
            (_, index) => `${TIMESTAMP} line-${String(index).padStart(3, "0")}`,
        );
        mkdirSync(join(env.home, "logs"), { recursive: true });
        writeFileSync(logPath, `${history.join("\n")}\n`);

        const actual = service.logs();

        assert.equal(actual.path, logPath);
        assert.equal(actual.truncated, true);
        assert.deepEqual(actual.lines, history.slice(-200));
    });

    it("keeps the whole first line when the byte boundary is a line boundary", () => {
        // 80 lines of exactly 4096 bytes each; the last 256 KiB holds exactly 64 full lines.
        const history = Array.from({ length: 80 }, (_, index) => {
            const label = `entry-${String(index).padStart(3, "0")}:`;
            return `${TIMESTAMP} ${label}${"x".repeat(4095 - TIMESTAMP.length - 1 - label.length)}`;
        });
        mkdirSync(join(env.home, "logs"), { recursive: true });
        writeFileSync(logPath, `${history.join("\n")}\n`);

        const actual = service.logs();

        assert.equal(actual.truncated, true);
        assert.deepEqual(actual.lines, history.slice(-64));
        const returnedBytes = Buffer.byteLength(actual.lines.join("\n"), "utf8");
        assert.ok(returnedBytes <= 256 * 1024, String(returnedBytes));
    });

    it("drops an unterminated trailing fragment", () => {
        mkdirSync(join(env.home, "logs"), { recursive: true });
        writeFileSync(logPath, `${TIMESTAMP} complete\n${TIMESTAMP} partial`);

        const actual = service.logs();

        assert.deepEqual(actual.lines, [`${TIMESTAMP} complete`]);
    });

    it("keeps an I/O error other than a missing file visible", () => {
        writeFileSync(join(env.home, "logs"), "this blocks the log folder");

        assert.throws(() => service.logs(), /ENOTDIR/u);
    });

    it("reads the persisted history after the service reopens", () => {
        service.log("before reopen");
        service.close();

        const reopened = MemoryService.open(env.home);
        try {
            const actual = reopened.logs();
            assert.equal(actual.lines.length, 1);
            assert.ok((actual.lines[0] ?? "").endsWith(" before reopen"));
        } finally {
            reopened.close();
        }
    });
});

describe("GET /api/logs", () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
        daemon = await openTestDaemon();
    });

    afterEach(async () => {
        await daemon.close();
    });

    it("requires the token from a loopback host and returns the snapshot", async () => {
        const anonymous = await daemon.app.inject({
            method: "GET",
            url: "/api/logs",
            headers: { host: "127.0.0.1" },
        });
        assert.equal(anonymous.statusCode, 401);
        const foreign = await daemon.app.inject({
            method: "GET",
            url: "/api/logs",
            headers: { host: "evil.example.com", authorization: `Bearer ${TEST_TOKEN}` },
        });
        assert.equal(foreign.statusCode, 403);

        const authorized = await daemon.api("GET", "/api/logs");
        assert.equal(authorized.status, 200);
        const expected = {
            path: join(daemon.env.home, "logs", "daemon.log"),
            lines: [],
            truncated: false,
        };
        assert.deepEqual(authorized.body, expected);
    });

    it("returns a visible 500 for a failed read without logging it", async () => {
        const logged: string[] = [];
        await daemon.close();
        daemon = await openTestDaemon({ log: (message) => logged.push(message) });
        writeFileSync(join(daemon.env.home, "logs"), "this blocks the log folder");

        const response = await daemon.api("GET", "/api/logs");

        assert.equal(response.status, 500);
        assert.match(response.body.error, /ENOTDIR/u);
        assert.deepEqual(logged, []);
    });

    it("lists a per-file import failure with its path and reason", async () => {
        const piRoot = daemon.env.folder("pi-sessions");
        const badPath = join(piRoot, "cwd-a", "bad.jsonl");
        writeText(badPath, jsonl([{ type: "message", id: "x" }]));
        daemon.service.setConfig({ harnesses: { pi: { enabled: true, root: piRoot } } });

        const imported = await daemon.api("POST", "/api/import", { harnesses: ["pi"] });
        assert.equal(imported.status, 200);
        assert.equal(imported.body.errors, 1);

        const snapshot = await daemon.api("GET", "/api/logs");
        assert.equal(snapshot.status, 200);
        assert.equal(snapshot.body.truncated, false);
        const failure = snapshot.body.lines.find((line: string) => line.includes(badPath));
        assert.ok(failure, snapshot.text);
        assert.match(failure, /\[ERROR\] \[IMPORT\] Import failed for /u);
        assert.match(
            failure,
            /Unknown format: Pi session file does not start with a session header/u,
        );
    });

    it("returns the import summary when the log sink fails and reports the write error on the event", async (t) => {
        const events: ServiceEvent[] = [];
        const stop = daemon.service.on((event) => events.push(event));
        const errorMock = t.mock.method(console, "error", () => {});
        try {
            const piRoot = daemon.env.folder("pi-sessions");
            const badPath = join(piRoot, "cwd-a", "bad.jsonl");
            writeText(badPath, jsonl([{ type: "message", id: "x" }]));
            daemon.service.setConfig({ harnesses: { pi: { enabled: true, root: piRoot } } });
            writeFileSync(join(daemon.env.home, "logs"), "this blocks the log folder");

            const imported = await daemon.api("POST", "/api/import", { harnesses: ["pi"] });

            assert.equal(imported.status, 200);
            assert.equal(imported.body.errors, 1);
            assert.equal(imported.body.problems[0]?.path, badPath);
            const logEvents = events.filter((event) => event.type === "log");
            assert.equal(logEvents.length, 1);
            const data = logEvents[0]?.data;
            assert.equal(data?.level, "error");
            assert.equal(data?.source, "import");
            const message = String(data?.message);
            assert.ok(message.includes(badPath), message);
            assert.match(message, /does not start with a session header/u);
            // A blocked logs folder fails at mkdir (EEXIST) or at the append (ENOTDIR).
            assert.match(String(data?.error), /EEXIST|ENOTDIR/u);
            assert.ok(errorMock.mock.callCount() > 0);
        } finally {
            stop();
            t.mock.restoreAll();
        }
    });
});

describe("startDaemon scheduler logs", () => {
    it("delivers a scheduler failure to the observer when the log sink fails", async (t) => {
        const home = makeTempDir();
        const observed: Array<{ message: string; level?: string; source?: string }> = [];
        const errorMock = t.mock.method(console, "error", () => {});
        let daemon: RunningDaemon | undefined;
        try {
            daemon = await startDaemon({
                home,
                schedule: false,
                log: (message: string, details?: { level?: string; source?: string }) => {
                    observed.push({ message, level: details?.level, source: details?.source });
                },
            });
            writeFileSync(join(home, "logs"), "this blocks the log folder");
            const events: ServiceEvent[] = [];
            const stop = daemon.service.on((event) => events.push(event));
            t.mock.method(daemon.service, "importNow", () => {
                throw new Error("synthetic store read failure");
            });
            try {
                daemon.scheduler.runImport();
            } finally {
                stop();
            }

            const failure = observed.find((entry) =>
                entry.message.includes("Import failed: synthetic store read failure"),
            );
            assert.ok(failure, JSON.stringify(observed));
            assert.equal(failure.level, "error");
            assert.equal(failure.source, "import");

            const logEvents = events.filter((event) => event.type === "log");
            assert.equal(logEvents.length, 1);
            const data = logEvents[0]?.data;
            assert.equal(data?.level, "error");
            assert.equal(data?.source, "import");
            assert.match(String(data?.message), /Import failed: synthetic store read failure/u);
            assert.match(String(data?.error), /EEXIST|ENOTDIR/u);
            assert.ok(errorMock.mock.callCount() > 0);
        } finally {
            try {
                await daemon?.stop();
            } finally {
                t.mock.restoreAll();
                removeDir(home);
            }
        }
    });
});
