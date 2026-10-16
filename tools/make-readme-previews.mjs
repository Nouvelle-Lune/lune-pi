/** Capture the real Pi TUI in a dedicated native Ghostty window. */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { watch } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import xterm from "@xterm/headless";
import { updatePackageImages } from "./real-demo/assets.mjs";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { help: { type: "boolean" }, output: { type: "string" }, palette: { type: "string", default: "pi-core-dark" }, "workspace-only": { type: "boolean", default: false } } });
if (values.help) {
    console.log("Usage: node tools/make-readme-previews.mjs [--output DIR] [--palette NAME] [--workspace-only]\nRequires macOS 15+, Ghostty, Swift, Python 3 and screen-recording permission.\nRuns all seven local plugins in Pi, captures native PNGs and MP4, and extracts a short GIF.\nThe model responses are scripted; tools, files, commands, layouts and terminal pixels are real.");
    process.exit(0);
}
const output = values.output ? resolve(values.output) : join(root, "docs/previews");
const palette = values.palette;
const workspaceOnly = values["workspace-only"];
const id = randomUUID().slice(0, 8);
const scratch = join(root, ".scratch/real-demo", id);
const sandbox = "/tmp/lune-pi-demo-" + id;
const project = join(sandbox, "lune-studio");
const agent = join(sandbox, "agent");
const eventsFile = join(scratch, "events.jsonl");
const socket = "/tmp/lune-pi-" + id + ".sock";
const title = "Lune for Pi · " + id;
const capture = join(scratch, "capture");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const packageRoot = join(root, "packages");
const names = ["pi-lune-extensions-core", "pi-core-theme", "pi-dock", "pi-ask-question", "pi-shell-inspector", "pi-compaction", "pi-recap"];
const packages = await Promise.all(names.map(async (name) => ({ name, path: join(packageRoot, name), manifest: await json(join(packageRoot, name, "package.json")) })));
const themes = packages[1].manifest.pi.themes.map((path) => path.split("/").at(-1).replace(".json", ""));
if (!themes.includes(palette)) throw new Error("Unknown theme: " + palette);
const artifacts = [];
let appPid;
let recorder;
let recordStart;
let questionStart;
let questionEnd;
let input;
let emulator;
let readOffset = 0;
const rawLog = join(scratch, "terminal.raw");
let failed = false;
await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
await mkdir(join(agent, "lune-settings"), { recursive: true });
await cp(join(root, "tools/real-demo/workspace"), project, { recursive: true });
await writeFile(eventsFile, "");
execFileSync("git", ["init", "-q", "-b", "main", project]);
execFileSync("swiftc", ["-parse-as-library", join(root, "tools/real-demo/capture.swift"), "-o", capture]);

async function untilFile(path, predicate, timeout = 30000) {
    const directory = dirname(path);
    let checking = false;
    let checkAgain = false;
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => finish(new Error("Timed out waiting for " + path)), timeout);
        const watcher = watch(directory, () => { void check(); });
        const finish = (error, value) => {
            clearTimeout(timer);
            watcher.close();
            error ? reject(error) : resolvePromise(value);
        };
        const check = async () => {
            if (checking) { checkAgain = true; return; }
            checking = true;
            try {
                const result = predicate(await readFile(path, "utf8"));
                if (result) finish(undefined, result);
            } catch (error) {
                if (error.code !== "ENOENT") finish(error);
            } finally {
                checking = false;
                if (checkAgain) { checkAgain = false; void check(); }
            }
        };
        void check();
    });
}
const events = async () => (await readFile(eventsFile, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
async function waitEvent(type, after = 0, predicate = () => true) {
    return untilFile(eventsFile, (data) => {
        const pending = data.split("\n").filter(Boolean).map(JSON.parse).slice(after);
        const failure = pending.find((event) => event.type === "provider-error" || event.type === "compaction-failed");
        if (failure) throw new Error(JSON.stringify(failure));
        return pending.find((event) => event.type === type && predicate(event));
    }, 60000);
}
async function control(command) {
    return new Promise((resolvePromise, reject) => {
        const client = connect(socket);
        client.once("error", reject);
        client.once("connect", () => client.write(JSON.stringify(command) + "\n"));
        client.once("data", (data) => {
            client.end();
            const result = JSON.parse(data.toString());
            if (result.ok) resolvePromise(result);
            else reject(new Error("Terminal rejected input"));
        });
    });
}
async function send(text) { await control({ send: text }); }
async function key(text, delay = 180) { await send(text); await pause(delay); }
async function command(text) {
    await key(text, 120);
    await key("\r", 400);
}
async function screen() {
    const bytes = await readFile(rawLog);
    if (bytes.length > readOffset) {
        await new Promise((resolvePromise) => emulator.write(bytes.subarray(readOffset), resolvePromise));
        readOffset = bytes.length;
    }
    return Array.from({ length: emulator.rows }, (_, row) => emulator.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
}
async function waitScreen(text) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if ((await screen()).includes(text)) return;
        await pause(80);
    }
    throw new Error("Expected terminal screen: " + text + "\nActual:\n" + await screen());
}
async function openSettings(section) {
    const offset = (await events()).length;
    await command("/lune-core-settings " + section);
    await waitEvent("ui-open", offset, (event) => event.kind === "custom");
    await waitScreen("Lune settings");
}
async function shot(name, expected) {
    if (expected) await waitScreen(expected);
    await pause(350);
    const path = join(output, name + ".png");
    execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l" + input.id, path]);
    artifacts.push({ path: name + ".png", time: (Date.now() - recordStart) / 1000 });
    console.log("Captured " + name);
}
async function scene(name, action) {
    console.log("Scene: " + name);
    await action();
}
async function demo(name) {
    const offset = (await events()).length;
    await command("/demo " + name);
    await waitEvent("agent-end", offset, (event) => event.scenario === name);
    await pause(650);
}

try {
    await writeFile(join(agent, "settings.json"), JSON.stringify({ theme: "dark", collapseChangelog: true, defaultThinkingLevel: "medium", compaction: { keepRecentTokens: 1024 } }));
    const settings = {
        "pi-core-theme": { enabled: true, palette, diffViewMode: "split", editDiffCollapsedLines: 4, expandedInputMaxLines: 4, expandedOutputMaxLines: 8 },
        "pi-dock": { enabled: true, style: "ruled", displayMode: "detail" },
        "pi-compaction": { enabled: true, summaryModel: { provider: "lune-demo-summary", id: "summary" } },
        "pi-recap": { enabled: false, model: { provider: "lune-demo-recap", id: "recap" } },
    };
    for (const [name, value] of Object.entries(settings)) await writeFile(join(agent, "lune-settings", name + ".json"), JSON.stringify(value));
    const environment = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    // Reuse installed helper binaries while keeping credentials and settings isolated.
    const hostAgent = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent");
    environment.PATH = join(hostAgent, "bin") + ":" + environment.PATH;
    execFileSync("which", ["fd"], { env: environment });
    Object.assign(environment, { TERM: "xterm-256color", COLORTERM: "truecolor", PI_CODING_AGENT_DIR: agent, LUNE_DEMO_EVENTS: eventsFile });
    const extensions = packages.flatMap((pkg) => pkg.manifest.pi.extensions.map((path) => join(pkg.path, path)));
    const argv = [execFileSync("which", ["pi"], { encoding: "utf8" }).trim(), "--no-extensions", ...extensions.flatMap((path) => ["-e", path]), "-e", join(root, "tools/real-demo/provider.mjs"), "--offline", "--no-session", "-nc", "-np", "-ns", "--provider", "lune-demo", "--model", "local", "--tui-mode", "fullscreen"];
    const ready = join(scratch, "ready.json");
    const exit = join(scratch, "exit.json");
    const launch = join(scratch, "launch.json");
    await writeFile(launch, JSON.stringify({ argv, env: environment, cwd: project, socket, ready, exit, rawLog: join(scratch, "terminal.raw"), cast: join(scratch, "terminal.cast") }));
    execFileSync("open", ["-na", "/Applications/Ghostty.app", "--args", "--config-default-files=false", "--window-save-state=never", "--quit-after-last-window-closed=true", "--confirm-close-surface=false", "--shell-integration=none", "--macos-shortcuts=allow", "--font-family=Menlo", "--font-size=12", "--window-width=128", "--window-height=44", "--window-padding-x=12", "--window-padding-y=8", "--title=" + title, "-e", execFileSync("which", ["python3"], { encoding: "utf8" }).trim(), join(root, "tools/real-demo/terminal.py"), launch]);
    const terminal = await untilFile(ready, (data) => JSON.parse(data));
    appPid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(terminal.parent)], { encoding: "utf8" }).trim());
    await waitEvent("ready");
    await pause(1200);
    input = JSON.parse(execFileSync(capture, ["window", String(appPid)], { encoding: "utf8" }));
    await writeFile(join(scratch, "window.json"), JSON.stringify(input));
    const geometry = await control({ syncSize: true });
    terminal.columns = geometry.columns;
    terminal.rows = geometry.rows;
    emulator = new xterm.Terminal({ cols: geometry.columns, rows: geometry.rows, allowProposedApi: true });
    await pause(500);
    appPid = input.pid;
    let recordingDone;
    if (!workspaceOnly) {
    recorder = spawn(capture, ["record", String(input.id), join(output, "walkthrough.mp4")], { stdio: ["pipe", "pipe", "pipe"] });
    let recorderError = "";
    recorder.stderr.on("data", (data) => { recorderError += data; });
    recordingDone = new Promise((resolvePromise, reject) => {
        recorder.once("error", reject);
        recorder.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("Native recording failed: " + recorderError)));
    });
    // Surface the promise immediately if the recorder fails before the walkthrough ends.
    recordingDone.catch((error) => console.error(error.message));
    await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error("Recorder did not start: " + recorderError)), 30000);
        recorder.stdout.on("data", (data) => { if (data.toString().includes("RECORDING")) { clearTimeout(timer); resolvePromise(); } });
        recorder.once("error", reject);
        recorder.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error("Recorder failed to start: " + recorderError)); } });
    });
    recordStart = Date.now();
    } else recordStart = Date.now();
    await shot("startup");
    await scene("workspace", async () => {
        await demo("workspace");
        await shot("workspace-dark");
        await key("\x0f", 650);
        await shot("tools-expanded");
        await key("\x0f", 500);
    });
    if (workspaceOnly) {
        await shot("workspace");
    } else {
    await scene("questions", async () => {
        questionStart = (Date.now() - recordStart) / 1000;
        const offset = (await events()).length;
        await command("/demo questions");
        await waitEvent("ui-open", offset, (event) => event.kind === "custom");
        await shot("ask-question", "Questions");
        await key("\x1b[B", 800);
        await shot("ask-question-alternative");
        await key("\x1b[A"); await key("\r", 600);
        await shot("ask-question-next");
        await key("\r", 600);
        await shot("ask-question-submit");
        const answerOffset = (await events()).length;
        await key("\r", 500);
        await waitEvent("agent-end", answerOffset, (event) => event.scenario === "questions");
        await shot("question-answered");
        questionEnd = (Date.now() - recordStart) / 1000;
    });
    await scene("shell and Dock", async () => {
        await demo("shell");
        await key("\x1b[B", 450);
        await key("\x1b[C", 450);
        await shot("dock-focus", "enter open");
        await key("\r", 700);
        await shot("shell-inspector", "Shell inspector");
        await key("\x1b[B", 750);
        await shot("shell-inspector-next");
        await key("\x1b[1;2A", 500);
        await shot("shell-inspector-scroll");
        await key("\x1b", 1000); await key("\x1b", 1000);
        await writeFile(join(project, "finish-background"), "done\n");
        await pause(4500);
    });
    await scene("settings", async () => {
        for (const [section, name] of [["core-theme", "theme-settings"], ["dock", "dock-styles"], ["compaction", "compaction"], ["recap", "recap-settings"]]) {
            await openSettings(section);
            await shot(name, "Lune settings");
            await key("\x1b", 1000);
        }
    });
    await scene("recap and compaction", async () => {
        await command("/demo prepare-recap");
        await command("/recap");
        await pause(1800);
        await shot("recap", "recap ·");
        await command("/demo prepare-compaction");
        const offset = (await events()).length;
        await command("/compact");
        await waitEvent("compacted", offset);
        await shot("compaction-result");
    });
    recorder.stdin.end();
    await recordingDone;
    recorder = undefined;
    execFileSync("swift", [join(root, "tools/real-demo/video-gif.swift"), join(output, "walkthrough.mp4"), join(output, "walkthrough.gif"), String(questionStart), String(questionEnd - questionStart)], { stdio: "inherit" });
    }
    const codeErrors = (await events()).filter((event) => event.type === "tool-end" && event.error || event.type === "compaction-failed" || event.type === "provider-error");
    if (codeErrors.length) throw new Error("Demo execution failed: " + JSON.stringify(codeErrors));
    const sources = {};
    for (const pkg of packages) {
        const entry = join(pkg.path, pkg.manifest.pi.extensions[0]);
        sources[pkg.name] = { version: pkg.manifest.version, entrySha256: createHash("sha256").update(await readFile(entry)).digest("hex") };
    }
    await writeFile(join(output, "capture.json"), JSON.stringify({ method: "Native Ghostty window: PNG via macOS screencapture, MP4 via ScreenCaptureKit", model: "Scripted offline provider; real Pi agent loop and plugin runtimes", terminal: { columns: terminal.columns, rows: terminal.rows, font: "Menlo", fontSize: 12 }, themes, sources, artifacts }, null, 2) + "\n");
    await command("/quit");
    const result = await untilFile(exit, (data) => JSON.parse(data));
    if (result.code !== 0) throw new Error("Pi exited with code " + result.code);
    if (!workspaceOnly) {
        for (const name of themes) {
            console.log("Palette capture: " + name);
            const childOutput = join(scratch, "palettes", name);
            execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--workspace-only", "--palette", name, "--output", childOutput], { stdio: "inherit" });
            await cp(join(childOutput, "workspace.png"), join(output, name + ".png"));
            if (name === "pi-core-dark") {
                await cp(join(childOutput, "workspace.png"), join(output, "workspace-dark.png"));
                await cp(join(childOutput, "startup.png"), join(output, "startup.png"));
            }
            if (name === "pi-core-light") await cp(join(childOutput, "workspace.png"), join(output, "workspace-light.png"));
        }
        if (output === join(root, "docs/previews")) await updatePackageImages(root, output, themes);
    }
    console.log("Completed real captures: " + output);
} catch (error) {
    failed = true;
    console.error(error.stack);
    process.exitCode = 1;
} finally {
    if (recorder) recorder.stdin.end();
    if (failed && input) {
        await send("\x1b");
        await send("\x1b");
        await send("\x03");
        await send("\x03");
    }
    emulator?.dispose();
    if (appPid && failed) process.kill(appPid, "SIGTERM");
    console.log("Capture logs retained at " + scratch);
}
