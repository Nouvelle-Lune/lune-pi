import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = `Usage: npm run tui:demo

Opens Pi offline with Core, the independent Recap extension and a mock provider.
Run /lune-core-settings to open the panel, or /recap to render a mock response through production code.
The demo uses temporary agent, project and session files; it does not change your settings.

Try:
  Enter           open appearance choices, then Up/Down to preview; Enter saves, Esc cancels
  Tab/Shift+Tab   change section
  Ctrl+G          switch global/project scope
  Ctrl+S          save the current candidate
  Ctrl+R          reset the selected override
  Esc             return from an editor or close the panel

Resize the terminal to compare side-by-side and stacked previews. Quit with /quit or Ctrl+C.
`;

async function main(): Promise<void> {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        process.stdout.write(usage);
        return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "lune-settings-demo-"));
    try {
        const project = path.join(root, "project");
        await mkdir(project);
        const session = path.join(root, "session.jsonl");
        const timestamp = new Date().toISOString();
        await writeFile(
            session,
            [
                { type: "session", version: 3, id: randomUUID(), timestamp, cwd: project },
                {
                    type: "message",
                    id: randomUUID(),
                    parentId: null,
                    timestamp,
                    message: {
                        role: "user",
                        content: "Sample conversation.",
                        timestamp: Date.now(),
                    },
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
        );
        process.stdout.write(
            "Starting offline TUI demo in a temporary workspace. Run /lune-core-settings or /recap.\n",
        );
        const args = [
            "--no-extensions",
            "-e",
            fileURLToPath(new URL("../../src/extension.ts", import.meta.url)),
            "-e",
            fileURLToPath(
                new URL("../../../pi-lune-extensions-core/dist/extension.js", import.meta.url),
            ),
            "-e",
            fileURLToPath(new URL("./recap-fixture.ts", import.meta.url)),
            "--session",
            session,
            "--model",
            "offline-recap/fixture",
            "--models",
            "offline-recap/fixture",
            "--offline",
            "-nc",
            "-np",
            "-ns",
        ];
        await new Promise<void>((resolve, reject) => {
            const child = spawn("pi", args, {
                cwd: project,
                env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent") },
                stdio: "inherit",
            });
            const interrupt = () => {
                child.kill("SIGINT");
            };
            const terminate = () => {
                child.kill("SIGTERM");
            };
            const releaseSignals = () => {
                process.off("SIGINT", interrupt);
                process.off("SIGTERM", terminate);
            };
            process.on("SIGINT", interrupt);
            process.on("SIGTERM", terminate);
            child.once("error", (error) => {
                releaseSignals();
                reject(error);
            });
            child.once("exit", (code, signal) => {
                releaseSignals();
                if (signal) reject(new Error(`Pi exited with signal ${signal}`));
                else {
                    process.exitCode = code ?? 1;
                    resolve();
                }
            });
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(
        `tui:demo failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
});
