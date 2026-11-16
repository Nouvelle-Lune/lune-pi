import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { TestContext } from "node:test";

import { main, type CliIo } from "../../src/cli.ts";
import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";

const ENV_KEYS = ["LUNE_MEMORY_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "USERPROFILE"];

export interface TempSandbox {
    root: string;
    home: string;
    claudeDir: string;
    codexDir: string;
    paths: MemoryPaths;
    env: NodeJS.ProcessEnv;
}

/**
 * Temp memory home plus temp Claude and Codex config dirs. The process env points at them and is
 * restored after the test. Auto start is off, so no test can start a real daemon.
 */
export function sandbox(t: TestContext, options: { autoStart?: boolean } = {}): TempSandbox {
    const root = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const home = join(root, "memory");
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    for (const dir of [home, claudeDir, codexDir]) mkdirSync(dir, { recursive: true });
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env["LUNE_MEMORY_HOME"] = home;
    process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
    process.env["CODEX_HOME"] = codexDir;
    process.env["HOME"] = root;
    process.env["USERPROFILE"] = root;
    t.after(() => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });
    const paths = memoryPaths(home);
    writeFileSync(paths.config, `${JSON.stringify({ autoStart: options.autoStart ?? false })}\n`);
    return { root, home, claudeDir, codexDir, paths, env: { ...process.env } };
}

export interface CliRun {
    code: number;
    stdout: string;
    stderr: string;
}

function sink(chunks: string[]): Writable {
    return new Writable({
        write(chunk: Buffer | string, _encoding, done) {
            chunks.push(chunk.toString());
            done();
        },
    });
}

/** Run `main` with captured output. `stdin` text is delivered and ended; none means no input. */
export async function runCli(
    argv: string[],
    options: { env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } = {},
): Promise<CliRun> {
    const out: string[] = [];
    const err: string[] = [];
    const stdin = new PassThrough();
    stdin.end(options.stdin ?? "");
    const io: Partial<CliIo> = {
        stdin,
        stdout: sink(out),
        stderr: sink(err),
        env: options.env ?? process.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    const code = await main(argv, io);
    return { code, stdout: out.join(""), stderr: err.join("") };
}
