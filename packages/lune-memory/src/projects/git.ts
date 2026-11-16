import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Read-only git queries. Each call has a short timeout and never prompts. A failed call gives
 * null, so a missing git or a broken repo never stops an import.
 */
export function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
            maxBuffer: 16 * 1024 * 1024,
        }).trimEnd();
    } catch {
        return null;
    }
}

export interface RepoInfo {
    /** Top level of the work tree that holds `cwd`. */
    root: string;
    /** Absolute git common dir. All worktrees of one repo have the same value. */
    commonDir: string;
    /** Current branch. Null when HEAD is detached. */
    branch: string | null;
    /** Normalized fetch URLs of the remotes, without duplicates. */
    remotes: string[];
}

function realpath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** The innermost git repo that holds `cwd`, or null when `cwd` is not in a repo. */
export function repoInfo(cwd: string): RepoInfo | null {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!root) return null;
    const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!commonDir) return null;
    const remotes = new Set<string>();
    for (const line of (git(cwd, ["remote", "-v"]) ?? "").split("\n")) {
        const match = /^\S+\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
        const url = match?.[1] ? normalizeRemote(match[1]) : null;
        if (url) remotes.add(url);
    }
    return {
        root: realpath(root),
        commonDir: realpath(commonDir),
        branch: currentBranch(root),
        remotes: [...remotes].sort(),
    };
}

/**
 * Branch that the work tree at `root` has checked out now, also before its first commit. Null on
 * a detached HEAD. The HEAD file gives it without a git process, so a caller can read it on each
 * call; git answers when that file has an unknown form.
 */
export function currentBranch(root: string): string | null {
    const head = headFile(root);
    if (head !== undefined) return head;
    return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
}

/** Branch in the HEAD file of a work tree: a name, null when detached, undefined when unknown. */
function headFile(root: string): string | null | undefined {
    try {
        let gitDir = join(root, ".git");
        if (statSync(gitDir).isFile()) {
            // A linked worktree or a submodule: `.git` names the real git dir.
            const link = /^gitdir:\s*(.+)$/mu.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim();
            if (!link) return undefined;
            gitDir = resolve(root, link);
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head)?.[1];
        if (ref) return ref;
        return /^[0-9a-f]{40,64}$/u.test(head) ? null : undefined;
    } catch {
        return undefined;
    }
}

/** Default port of each remote protocol. A URL with this port names the same remote as one without. */
const DEFAULT_PORTS: Record<string, string> = {
    git: "9418",
    http: "80",
    https: "443",
    ssh: "22",
};

/**
 * Normalize a remote URL to `host/path`: no protocol, no user, no `.git`, a lowercase host. A port
 * that is not the default port of the protocol stays (`host:2222/path`), because two services on
 * one host are two remotes. Local path remotes give null, because they do not identify a project
 * on another machine.
 */
export function normalizeRemote(url: string): string | null {
    let value = url.trim();
    if (!value) return null;
    if (value.startsWith("/") || value.startsWith(".") || value.startsWith("file:")) return null;
    let defaultPort: string | undefined = DEFAULT_PORTS.ssh;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value);
    if (scheme?.[1]) {
        // `git+ssh` and `ssh+git` are ssh.
        const protocol = scheme[1].toLowerCase();
        defaultPort = DEFAULT_PORTS[protocol.includes("ssh") ? "ssh" : protocol];
        value = value.slice(scheme[0].length).replace(/^[^@/]+@/u, "");
    } else {
        // scp syntax: `user@host:path`.
        const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(.+)$/u.exec(value);
        if (!scp?.[1] || !scp[2]) return null;
        value = `${scp[1]}/${scp[2].replace(/^\/+/u, "")}`;
    }
    value = value
        .replace(/\/+$/u, "")
        .replace(/\.git$/u, "")
        .replace(/\/+$/u, "");
    const slash = value.indexOf("/");
    if (slash <= 0) return null;
    const authority = value.slice(0, slash).toLowerCase();
    const port = /:(\d+)$/u.exec(authority)?.[1];
    const host =
        port === undefined || port === defaultPort ? authority.replace(/:\d*$/u, "") : authority;
    const path = value.slice(slash + 1);
    return path ? `${host}/${path}` : null;
}

/** Branches that count as the mainline. A mainline branch is never closed. */
export const MAINLINE_NAMES = ["main", "master", "dev", "develop", "trunk"];

export type BranchState = "open" | "merged" | "deleted";

/** Local and remote-tracking refs of the mainline, plus the target of `origin/HEAD`. */
function mainlineRefs(root: string): string[] {
    const refs: string[] = [];
    const originHead = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (originHead) refs.push(originHead);
    for (const name of MAINLINE_NAMES) {
        refs.push(`refs/heads/${name}`, `refs/remotes/origin/${name}`);
    }
    const existing = new Set(
        (git(root, ["for-each-ref", "--format=%(refname)", ...refs]) ?? "")
            .split("\n")
            .filter(Boolean),
    );
    return [...new Set(refs)].filter((ref) => existing.has(ref));
}

/** Branches checked out in a worktree of the repo. */
function worktreeBranches(root: string): Set<string> {
    const out = new Set<string>();
    for (const line of (git(root, ["worktree", "list", "--porcelain"]) ?? "").split("\n")) {
        if (line.startsWith("branch refs/heads/")) out.add(line.slice("branch refs/heads/".length));
    }
    return out;
}

/** Tip of a branch: the local ref, else a remote-tracking ref. Null when no ref exists. */
function branchTip(root: string, branch: string): string | null {
    const local = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (local) return local;
    const remote = git(root, [
        "for-each-ref",
        "--count=1",
        "--format=%(objectname)",
        `refs/remotes/*/${branch}`,
    ]);
    return remote ? remote : null;
}

const STATE_RANK: Record<BranchState, number> = { open: 0, merged: 1, deleted: 2 };

/**
 * State of each branch across all clones of a project, with no model call. A branch is open when
 * one clone has it open, merged when no clone has it open and one has it merged, and deleted only
 * when no clone has a ref with its name. A root that is not a repo now, such as the old path of a
 * moved clone, does not count. With no valid root, every branch stays open.
 */
export function branchStates(
    roots: readonly string[],
    branches: readonly string[],
): Map<string, BranchState> {
    const out = new Map<string, BranchState>();
    for (const root of new Set(roots)) {
        const states = cloneBranchStates(root, branches);
        if (!states) continue;
        for (const [branch, state] of states) {
            const best = out.get(branch);
            if (!best || STATE_RANK[state] < STATE_RANK[best]) out.set(branch, state);
        }
    }
    for (const branch of branches) if (!out.has(branch)) out.set(branch, "open");
    return out;
}

/**
 * State of each branch in one clone. A branch is deleted when no local or remote ref has its
 * name. It is merged when no worktree has it checked out and its tip is in a mainline ref. A
 * mainline branch stays open. Null when `root` is not a repo.
 */
function cloneBranchStates(
    root: string,
    branches: readonly string[],
): Map<string, BranchState> | null {
    if (git(root, ["rev-parse", "--git-dir"]) === null) return null;
    const out = new Map<string, BranchState>();
    const mainline = mainlineRefs(root);
    const checkedOut = worktreeBranches(root);
    for (const branch of branches) {
        if (MAINLINE_NAMES.includes(branch) || checkedOut.has(branch)) {
            out.set(branch, "open");
            continue;
        }
        const tip = branchTip(root, branch);
        if (!tip) {
            out.set(branch, "deleted");
            continue;
        }
        const merged = mainline.some(
            (ref) => git(root, ["merge-base", "--is-ancestor", tip, ref]) !== null,
        );
        out.set(branch, merged ? "merged" : "open");
    }
    return out;
}
