/**
 * One real Pi runtime per process, so the default unhandled-rejection behavior decides
 * whether a session scan that finishes after replacement can crash the host.
 *
 * The scan is held at the PiSessions.list I/O boundary and released only after the
 * replacement completed, matching file I/O that notices the session shutdown last.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    SessionManager,
    type ExtensionError,
    type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { createMentionHost, type MentionNotice } from "./mention-runtime.ts";
import { ExternalSessions } from "../../src/mention/external.ts";
import { PiSessions } from "../../src/mention/pi.ts";
import { SessionFile } from "./session-fixtures.ts";

const TARGET_ID = "01a14931-31bb-7000-8000-bbbbbbbbbbbb";

const scenario = process.argv[2];
if (
    scenario !== "reload" &&
    scenario !== "new" &&
    scenario !== "fork" &&
    scenario !== "resume" &&
    scenario !== "shutdown"
) {
    throw new Error(`Expected reload, new, fork, resume or shutdown, got ${String(scenario)}`);
}
// A late ordinary I/O failure must be discarded like the abort the catalog raises itself.
const lateFailure = process.argv[3];
if (lateFailure !== undefined && lateFailure !== "io-error") {
    throw new Error(`Expected no failure mode or io-error, got ${lateFailure}`);
}

const agentDir = process.env["PI_CODING_AGENT_DIR"];
assert.ok(agentDir, "PI_CODING_AGENT_DIR must isolate the child from installed sessions");
const root = dirname(agentDir);
const cwd = join(root, "project");
const sessionDir = join(root, "sessions");
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });

const target = new SessionFile(TARGET_ID, cwd);
target.user("earlier question");
target.assistant("earlier answer");
const targetPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${TARGET_ID}.jsonl`);
await writeFile(targetPath, target.jsonl());

let releaseScan!: () => void;
const heldScan = new Promise<void>((resolve) => {
    releaseScan = resolve;
});
let scans = 0;
let scanWasAborted = false;
let resolveFollowUpScan!: () => void;
const followUpScan = new Promise<void>((resolve) => {
    resolveFollowUpScan = resolve;
});
// The catalog reads its index file before listing, so the scan starts after the host is up.
let startupScanStarted!: () => void;
const startupScan = new Promise<void>((resolve) => {
    startupScanStarted = resolve;
});
const originalPiList = PiSessions.prototype.list;
PiSessions.prototype.list = async function (signal, report) {
    const call = ++scans;
    if (call === 1) {
        startupScanStarted();
        await heldScan;
        scanWasAborted = signal.aborted;
        if (lateFailure === "io-error") throw new Error("held scan failed");
        // Real listing that reaches its abort check only after the session was replaced.
        signal.throwIfAborted();
        return originalPiList.call(this, signal, report);
    }
    try {
        return await originalPiList.call(this, signal, report);
    } finally {
        resolveFollowUpScan();
    }
};

const initialSession = SessionManager.create(cwd, sessionDir);
initialSession.appendMessage({
    role: "user",
    content: "Persist the initial session before replacing it",
    timestamp: Date.now(),
});
// The startup scan also reads external stores. Let that I/O finish while the session is active,
// so the held Pi listing is the only part still pending at replacement.
let resolveExternalScan!: () => void;
const externalScan = new Promise<void>((resolve) => {
    resolveExternalScan = resolve;
});
const originalExternalList = ExternalSessions.prototype.list;
let externalScans = 0;
ExternalSessions.prototype.list = async function (signal, report) {
    const call = ++externalScans;
    try {
        return await originalExternalList.call(this, signal, report);
    } finally {
        if (call === 1) resolveExternalScan();
    }
};
const host = await createMentionHost({ cwd, agentDir, sessionManager: initialSession });
await startupScan;
assert.equal(scans, 1, "the startup scan must be the held one");
await externalScan;

switch (scenario) {
    case "reload":
        await host.runtime.session.reload();
        break;
    case "new":
        await host.runtime.newSession();
        break;
    case "fork": {
        const leafId = initialSession.getLeafId();
        assert.ok(leafId);
        await host.runtime.fork(leafId, { position: "at" });
        break;
    }
    case "resume":
        await host.runtime.switchSession(targetPath);
        break;
    case "shutdown":
        await host.dispose();
        break;
}

releaseScan();
if (scenario !== "shutdown") await followUpScan;
// Let the released scan's rejection handlers and the follow-up catalog settle.
await new Promise<void>((resolve) => setImmediate(resolve));

let mention: InputEventResult | undefined;
if (scenario !== "shutdown") {
    mention = await host.runtime.session.extensionRunner.emitInput(
        `@session:${TARGET_ID.slice(0, 13)}`,
        [],
        "interactive",
    );
}
if (scenario !== "shutdown") await host.dispose();
await new Promise<void>((resolve) => setImmediate(resolve));

const notices: MentionNotice[] = host.bindings.flatMap((binding) => binding.notices);
const errors: ExtensionError[] = host.bindings.flatMap((binding) => binding.errors);
console.log(
    `RESULT ${JSON.stringify({
        scenario,
        scans,
        scanWasAborted,
        bindings: host.bindings.length,
        notices,
        errors,
        mention,
    })}`,
);
