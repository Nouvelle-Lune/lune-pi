import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
    return execFileSync(
        "git",
        [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
        ],
        {
            cwd,
            encoding: "utf8",
            // Neither the user's nor the system's Git configuration may reach a test repository.
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        },
    ).trim();
}

/** A repository with one commit holding `files`; returns the commit hash. */
export function createRepo(dir: string, files: Record<string, string>): string {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "--quiet", "--initial-branch=main");

    for (const [name, content] of Object.entries(files)) {
        const file = join(dir, name);

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }

    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "initial");

    return git(dir, "rev-parse", "HEAD");
}
