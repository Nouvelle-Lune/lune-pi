import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import {
    lockHolder,
    readDaemonInfo,
    removeDaemonInfo,
    writeDaemonInfo,
    type DaemonInfo,
} from "../../src/api/daemon-info.ts";
import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";
import { createTestEnv, type TestEnv } from "../harness/daemon.ts";

let env: TestEnv;
let paths: MemoryPaths;

before(() => {
    env = createTestEnv();
    paths = memoryPaths(env.home);
    mkdirSync(env.home, { recursive: true });
});

after(() => env.cleanup());

function info(pid: number): DaemonInfo {
    return {
        pid,
        port: 4321,
        token: "test-token-not-real",
        url: "http://127.0.0.1:4321",
        startedAt: "2026-01-01T00:00:00.000Z",
        version: "1.2.3",
    };
}

/** A process id that no live process has: a child that already exited. */
async function deadPid(): Promise<number> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once("exit", resolve));
    return pid;
}

describe("daemon.json", () => {
    it("round-trips for a live pid and is readable only by the owner", () => {
        const expected = info(process.pid);
        writeDaemonInfo(paths, expected);
        assert.deepEqual(readDaemonInfo(paths), expected);
        assert.equal(statSync(paths.daemon).mode & 0o777, 0o600);
    });

    it("ignores a stale file of a dead pid", async () => {
        writeDaemonInfo(paths, info(await deadPid()));
        assert.equal(readDaemonInfo(paths), null);
    });

    it("ignores a corrupt file or one with missing fields", () => {
        writeFileSync(paths.daemon, "{ not json");
        assert.equal(readDaemonInfo(paths), null);
        writeFileSync(
            paths.daemon,
            JSON.stringify({ pid: process.pid, port: 1, url: "u", token: "" }),
        );
        assert.equal(readDaemonInfo(paths), null);
        writeFileSync(paths.daemon, "null");
        assert.equal(readDaemonInfo(paths), null);
    });

    it("fills defaults for the optional fields", () => {
        writeFileSync(
            paths.daemon,
            JSON.stringify({ pid: process.pid, port: 1, token: "t", url: "http://127.0.0.1:1" }),
        );
        const actual = readDaemonInfo(paths);
        assert.equal(actual?.startedAt, "");
        assert.equal(actual?.version, "0.0.0");
    });

    it("removes the file only for the pid that wrote it", () => {
        writeDaemonInfo(paths, info(process.pid));
        removeDaemonInfo(paths, process.pid + 1);
        assert.notEqual(readDaemonInfo(paths), null);
        removeDaemonInfo(paths, process.pid);
        assert.equal(readDaemonInfo(paths), null);
    });
});

describe("lockHolder", () => {
    it("returns the pid of a live holder", () => {
        writeFileSync(paths.lock, `${process.pid}\n`);
        assert.equal(lockHolder(paths), process.pid);
    });

    it("returns null for a dead holder, garbage or a missing file", async () => {
        writeFileSync(paths.lock, `${await deadPid()}\n`);
        assert.equal(lockHolder(paths), null);
        writeFileSync(paths.lock, "garbage");
        assert.equal(lockHolder(paths), null);
        assert.equal(lockHolder(memoryPaths(`${env.home}-none`)), null);
    });
});
