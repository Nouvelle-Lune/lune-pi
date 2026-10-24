import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { RunWorktree } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface CreatedWorktree extends RunWorktree {
    /** The worktree folder that matches the parent's working directory. */
    cwd: string;
}

async function git(args: string[], signal?: AbortSignal): Promise<string> {
    try {
        const { stdout } = await execFileAsync("git", args, { signal, maxBuffer: 1024 * 1024 });

        return stdout.trim();
    } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        const detail =
            typeof stderr === "string" && stderr.trim() !== ""
                ? stderr.trim()
                : error instanceof Error
                  ? error.message
                  : String(error);

        throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
    }
}

/**
 * Check out the parent repository's current HEAD in a detached worktree.
 *
 * The worktree holds the commit only: the parent's staged, unstaged, untracked and ignored files
 * stay where they are, and nothing is stashed or committed for the run.
 */
export async function createRunWorktree(
    parentCwd: string,
    worktreePath: string,
    signal?: AbortSignal,
): Promise<CreatedWorktree> {
    let repoRoot: string;
    let prefix: string;

    try {
        repoRoot = await git(["-C", parentCwd, "rev-parse", "--show-toplevel"], signal);
        // The prefix, not a path relative to repoRoot: the parent's cwd may reach the repository
        // through a symlink that --show-toplevel resolves. Git ends it with a slash.
        prefix = (await git(["-C", parentCwd, "rev-parse", "--show-prefix"], signal)).replace(
            /\/+$/,
            "",
        );
    } catch (error) {
        throw new Error(
            `Worktree isolation needs a Git repository at ${parentCwd}. ${errorMessage(error)}`,
            { cause: error },
        );
    }

    let baseCommit: string;

    try {
        baseCommit = await git(["-C", repoRoot, "rev-parse", "--verify", "HEAD^{commit}"], signal);
    } catch (error) {
        throw new Error(
            `Worktree isolation needs a HEAD commit in ${repoRoot}. ${errorMessage(error)}`,
            { cause: error },
        );
    }

    if (existsSync(worktreePath)) {
        throw new Error(`The worktree path already exists: ${worktreePath}`);
    }

    mkdirSync(dirname(worktreePath), { recursive: true });
    await git(["-C", repoRoot, "worktree", "add", "--detach", worktreePath, baseCommit], signal);

    const cwd = prefix === "" ? worktreePath : join(worktreePath, prefix);

    if (!isDirectory(cwd)) {
        await removeRunWorktree(repoRoot, worktreePath);

        throw new Error(
            `The working directory ${prefix} does not exist in commit ${baseCommit.slice(0, 12)}, ` +
                "so the worktree has no matching folder for the run. Use shared isolation, or " +
                "commit the folder first.",
        );
    }

    return { repoRoot, path: worktreePath, baseCommit, cwd };
}

/** Only for a worktree this package just created and no run uses yet. */
export async function removeRunWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    await git(["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
}

/** A continued run must find its own checkout; it is never recreated from a clean commit. */
export async function assertWorktreeUsable(worktree: RunWorktree, cwd: string): Promise<void> {
    if (!isDirectory(worktree.path)) {
        throw new Error(
            `The run's worktree is missing: ${worktree.path}. It cannot continue; start a new run.`,
        );
    }

    let inside: string;

    try {
        inside = await git(["-C", worktree.path, "rev-parse", "--is-inside-work-tree"]);
    } catch (error) {
        throw new Error(
            `The run's worktree is not a usable Git worktree: ${worktree.path}. ${errorMessage(error)}`,
            { cause: error },
        );
    }

    if (inside !== "true") {
        throw new Error(`The run's worktree is not a Git work tree: ${worktree.path}.`);
    }

    if (!isDirectory(cwd)) {
        throw new Error(`The run's working directory is missing: ${cwd}.`);
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
