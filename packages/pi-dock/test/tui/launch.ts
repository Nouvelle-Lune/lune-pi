/** Launches an offline Pi session that demonstrates the shared Lune dock with both contributors. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: npm run tui:demo

Opens the real Pi TUI with pi-shell-inspector, pi-ask-question and pi-dock. A local faux
provider starts one real background shell and asks one question, without a network request.

Try:
  Esc                  defer the initial question and reveal both dock items
  Down                 enter dock Focus while the editor is empty
  Left / Right         move between Shell and Question
  Enter                open the selected plugin panel; Esc returns to dock Focus
  Esc                  leave dock Focus and return to the editor

Resize the terminal to check the one-line overflow behavior. Quit Pi with Ctrl+C or /quit.
`;

/** Resolves a file relative to this launcher's directory for Pi's -e option. */
function localFile(relativePath: string): string {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

function main(): void {
    const argv = process.argv.slice(2);
    if (argv[0] === "--help" || argv[0] === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    const extensions = [
        // Contributors load before the host so their presence callbacks exercise startup ordering.
        localFile("../../../pi-shell-inspector/src/index.ts"),
        localFile("../../../pi-ask-question/src/index.ts"),
        localFile("../../src/index.ts"),
        localFile("./dock-provider.ts"),
    ];
    const args = [
        "--no-extensions",
        ...extensions.flatMap((extension) => ["-e", extension]),
        "--no-session",
        "-nc",
        "-np",
        "-ns",
        "--offline",
        "--provider",
        "faux",
        "--model",
        "faux-1",
        "Start the Lune dock demo",
    ];

    const child = spawn("pi", args, { stdio: "inherit" });
    child.on("error", (error) => {
        process.stderr.write(`tui:demo could not start pi: ${error.message}\n`);
        process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
        if (code !== null) {
            process.exitCode = code;
            return;
        }
        process.stderr.write(`tui:demo: pi was terminated by signal ${signal ?? "unknown"}\n`);
        process.exitCode = 1;
    });
}

try {
    main();
} catch (error) {
    process.stderr.write(`tui:demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
