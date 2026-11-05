#!/usr/bin/env node
/**
 * Read-only repository metrics for an agent-driven review workflow.
 *
 * The script answers "where does human effort actually go?" with numbers instead of
 * guesses: how much removed code was written moments earlier, how fast a fix follows
 * the change it repairs, how many commits were rewritten before landing, and how much
 * of each commit survived to the current revision.
 *
 * Read-only contract:
 * - every git call goes through a command allowlist (see GIT_RULES);
 * - optional locks stay disabled, so no index refresh is written;
 * - the network is never touched unless --pull-requests is passed;
 * - git metadata is fingerprinted before and after the run and any change fails the
 *   run with exit code 4.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const TOOL_NAME = "review-metrics";
const TOOL_VERSION = "1.0.0";
const SCHEMA_VERSION = 1;

const EXIT = {
    ok: 0,
    usage: 2,
    git: 3,
    readOnlyViolation: 4,
    tool: 5,
};

class MetricError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "MetricError";
        this.code = code;
    }
}

const CLI = {
    repo: { type: "string" },
    range: { type: "string" },
    head: { type: "string", default: "HEAD" },
    since: { type: "string" },
    until: { type: "string" },
    json: { type: "boolean", default: false },
    output: { type: "string" },
    top: { type: "string", default: "8" },
    "rework-window-hours": { type: "string", default: "24" },
    "fix-types": { type: "string", default: "fix,hotfix" },
    "max-commits": { type: "string", default: "2000" },
    "max-blame-calls": { type: "string", default: "4000" },
    "max-file-pairs": { type: "string", default: "2000" },
    "min-survival-lines": { type: "string", default: "20" },
    exclude: { type: "string", multiple: true, default: [] },
    "no-rewrites": { type: "boolean", default: false },
    "no-survival": { type: "boolean", default: false },
    "self-check": { type: "string", default: "strict" },
    "pull-requests": { type: "boolean", default: false },
    "pr-limit": { type: "string", default: "200" },
    timestamp: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
};

const GIT_RULES = {
    "rev-parse": () => true,
    "rev-list": () => true,
    log: () => true,
    diff: () => true,
    blame: () => true,
    show: () => true,
    "ls-tree": () => true,
    "ls-files": () => true,
    "for-each-ref": () => true,
    "merge-base": () => true,
    fsck: () => true,
    "cat-file": (rest) => ["-e", "-s", "-t", "-p"].includes(rest[0]),
    stash: (rest) => rest[0] === "list",
};

// Revisions come from the command line, so they must never look like an option.
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@^~:{}-]*$/;
const FORBIDDEN_ARG = /^--(exec|ext-diff|output|upload-pack|receive-pack|filters)/;

const AREAS = ["code", "docs", "bookkeeping", "assets", "other"];

const AGE_LABELS = {
    lt1h: "<1h",
    lt6h: "<6h",
    lt1d: "<1d",
    lt3d: "<3d",
    lt7d: "<7d",
    lt14d: "<14d",
    gte14d: ">=14d",
    unknown: "unknown",
};

const HELP = `review-metrics ${TOOL_VERSION} — read-only review-workflow metrics

Usage
  node review-workflow/scripts/review-metrics.mjs [options]

Options
  --repo <path>              repository to measure (default: current directory)
  --range <a..b>             commit range to analyze (default: all history of --head)
  --head <rev>              revision for survival and default range (default: HEAD)
  --since <date>             lower bound, passed to git log --since
  --until <date>             upper bound, passed to git log --until
  --json                     machine-readable report on stdout
  --output <path>            write the JSON report to a file outside the repository
  --top <n>                  examples per section (default: 8)
  --rework-window-hours <n>  window for fix-after-change pairs (default: 24)
  --fix-types <list>         commit types treated as fixes (default: fix,hotfix)
  --exclude <glob>           path glob to leave out of deletion/rework analysis (repeatable)
  --max-commits <n>          cap on analyzed commits, newest kept (default: 2000)
  --max-blame-calls <n>      cap on git blame calls (default: 4000)
  --max-file-pairs <n>       cap on fix-after-change pairs verified (default: 2000)
  --min-survival-lines <n>   minimum added lines for a survival sample (default: 20)
  --no-rewrites              skip the unreachable-commit scan
  --no-survival             skip the survivorship analysis
  --self-check <mode>        strict | warn | off (default: strict)
  --pull-requests            add GitHub PR aggregates through gh (network, opt-in)
  --pr-limit <n>             PRs fetched with --pull-requests (default: 200)
  --timestamp                include generatedAt in the report
  --quiet                    suppress progress output
  --help                     show this help

Exit codes
  0  report produced
  2  usage error
  3  git command failed
  4  read-only self-check failed
  5  external tool failed (gh)

Metric definitions and known biases are documented in review-workflow/README.md.
`;

// ---------------------------------------------------------------- utilities

function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function share(part, total) {
    return total === 0 ? 0 : round(part / total);
}

function pct(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
    return sorted[index];
}

function isoDate(seconds) {
    return new Date(seconds * 1000).toISOString();
}

function truncate(text, length = 72) {
    return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function number(value) {
    return value.toLocaleString("en-US");
}

function assertRevision(value, label) {
    if (typeof value !== "string" || !REVISION.test(value)) {
        throw new MetricError(`invalid ${label}: ${JSON.stringify(value)}`, EXIT.usage);
    }
    return value;
}

function globToRegExp(glob) {
    let source = "^";
    let index = 0;
    while (index < glob.length) {
        const char = glob[index];
        if (char === "*" && glob[index + 1] === "*") {
            if (glob[index + 2] === "/") {
                source += "(?:.*/)?";
                index += 3;
            } else {
                source += ".*";
                index += 2;
            }
            continue;
        }
        if (char === "*") {
            source += "[^/]*";
        } else if (char === "?") {
            source += "[^/]";
        } else if ("\\^$+.()|{}[]".includes(char)) {
            source += `\\${char}`;
        } else {
            source += char;
        }
        index += 1;
    }
    return new RegExp(`${source}$`);
}

function classifyPath(path) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "CHANGELOG.md" || name.endsWith("lock.json") || name === "package-lock.json") {
        return "bookkeeping";
    }
    if (path.startsWith(".github/") || path.startsWith(".pi/")) return "bookkeeping";
    if (/\.(png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|woff2?|ttf)$/i.test(name)) return "assets";
    if (/\.(md|mdx)$/i.test(name) || path.startsWith("docs/") || path.includes("/docs/")) {
        return "docs";
    }
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|swift|py|sh|css|html)$/i.test(name)) return "code";
    return "other";
}

function commitType(subject) {
    const match = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject);
    return match ? match[1] : "other";
}

// ---------------------------------------------------------------- git access

const GIT_ENV = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
};

function git(repo, args, options = {}) {
    const { allowFailure = false, maxBuffer = 256 * 1024 * 1024 } = options;
    const [command, ...rest] = args;
    const rule = GIT_RULES[command];
    if (!rule) {
        throw new MetricError(
            `refusing to run non read-only git command: ${command}`,
            EXIT.readOnlyViolation,
        );
    }
    if (!rule(rest)) {
        throw new MetricError(
            `refusing to run git ${command} ${rest.join(" ")}: not read-only`,
            EXIT.readOnlyViolation,
        );
    }
    for (const arg of args) {
        if (FORBIDDEN_ARG.test(arg)) {
            throw new MetricError(`refusing unsafe git argument: ${arg}`, EXIT.readOnlyViolation);
        }
    }
    const result = spawnSync("git", ["--no-optional-locks", "-C", repo, ...args], {
        env: GIT_ENV,
        encoding: "utf8",
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
        throw new MetricError(`cannot run git: ${result.error.message}`, EXIT.git);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new MetricError(
            `git ${args.join(" ")} failed (${result.status}): ${(result.stderr || "").trim()}`,
            EXIT.git,
        );
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function revParse(repo, revision) {
    const result = git(repo, ["rev-parse", "--verify", "--quiet", revision], {
        allowFailure: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------- read-only proof

function fingerprintGitMetadata(repo) {
    const gitDirRaw = git(repo, ["rev-parse", "--git-dir"]).stdout.trim();
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repo, gitDirRaw);
    const entries = [];
    const record = (path) => {
        try {
            const stats = statSync(path);
            entries.push(`${relative(gitDir, path)}\t${stats.size}\t${Math.floor(stats.mtimeMs)}`);
        } catch {
            // A missing optional file is part of the baseline.
        }
    };
    for (const name of ["index", "HEAD", "packed-refs", "config", "FETCH_HEAD", "ORIG_HEAD"]) {
        record(join(gitDir, name));
    }
    const walk = (directory) => {
        let items;
        try {
            items = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of items) {
            const path = join(directory, item.name);
            if (item.isDirectory()) walk(path);
            else record(path);
        }
    };
    walk(join(gitDir, "refs"));
    return entries.sort();
}

function diffFingerprints(before, after) {
    const previous = new Set(before);
    const current = new Set(after);
    const added = after.filter((entry) => !previous.has(entry));
    const removed = before.filter((entry) => !current.has(entry));
    return [...added.map((entry) => `+${entry}`), ...removed.map((entry) => `-${entry}`)];
}

// ---------------------------------------------------------------- collection

function readCommits(repo, target, options) {
    const args = [
        "log",
        "--no-merges",
        "--no-renames",
        "-z",
        "--format=%H%x1f%ct%x1f%an%x1f%s",
        "--numstat",
        target,
    ];
    if (options.since) args.push(`--since=${options.since}`);
    if (options.until) args.push(`--until=${options.until}`);

    const raw = git(repo, args).stdout;
    const commits = new Map();
    let current = null;

    for (const token of raw.split("\u0000")) {
        const chunk = token.replace(/^\n+/, "");
        if (chunk === "") continue;
        if (/^[0-9a-f]{40}\u001f/.test(chunk)) {
            const [sha, seconds, author, subject] = chunk.split("\u001f");
            current = {
                sha,
                time: Number(seconds),
                author,
                subject,
                type: commitType(subject),
                files: new Map(),
            };
            commits.set(sha, current);
            continue;
        }
        if (!current) continue;
        const [add, del, ...rest] = chunk.split("\t");
        const path = rest.join("\t");
        if (path === "") continue;
        current.files.set(path, {
            add: add === "-" ? 0 : Number(add),
            del: del === "-" ? 0 : Number(del),
        });
    }
    return commits;
}

function readOrder(repo, target, limit) {
    const raw = git(repo, [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--no-merges",
        target,
    ]).stdout.trim();
    const shas = raw === "" ? [] : raw.split("\n");
    return { order: shas.slice(Math.max(0, shas.length - limit)), truncated: shas.length > limit };
}

function readCommitTimes(repo) {
    const times = new Map();
    for (const line of git(repo, ["log", "--all", "--format=%H%x1f%ct"]).stdout.split("\n")) {
        const [sha, seconds] = line.split("\u001f");
        if (sha) times.set(sha, Number(seconds));
    }
    return times;
}

function blameLines(state, revision, path) {
    const key = `${revision}\u0000${path}`;
    const cached = state.blameCache.get(key);
    if (cached) return cached;
    if (state.blameCalls >= state.opts.maxBlameCalls) {
        state.truncated.blame = true;
        return new Map();
    }
    state.blameCalls += 1;
    const result = git(state.repo, ["blame", "-l", "--line-porcelain", revision, "--", path], {
        allowFailure: true,
    });
    const lines = new Map();
    if (result.status === 0) {
        for (const line of result.stdout.split("\n")) {
            const match = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
            if (match) lines.set(Number(match[2]), match[1]);
        }
    }
    state.blameCache.set(key, lines);
    return lines;
}

function deletedRanges(repo, parent, sha, path) {
    const ranges = [];
    const raw = git(repo, [
        "diff",
        "-U0",
        "--no-color",
        "--no-renames",
        parent,
        sha,
        "--",
        path,
    ]).stdout;
    for (const line of raw.split("\n")) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        if (!match) continue;
        const count = Number(match[2] ?? 1);
        if (count > 0) ranges.push({ start: Number(match[1]), count });
    }
    return ranges;
}

// ---------------------------------------------------------------- analyses

function analyzeInventory(state, target) {
    const { repo, commits, order } = state;
    const authors = new Map();
    let added = 0;
    let deleted = 0;
    for (const sha of order) {
        const commit = commits.get(sha);
        authors.set(commit.author, (authors.get(commit.author) ?? 0) + 1);
        for (const file of commit.files.values()) {
            added += file.add;
            deleted += file.del;
        }
    }
    const merges = Number(
        git(repo, ["rev-list", "--count", "--merges", target]).stdout.trim() || "0",
    );
    const tracked = git(repo, ["ls-files"]).stdout.split("\n").filter(Boolean).length;
    const times = order.map((sha) => commits.get(sha).time);
    return {
        commits: { analyzed: order.length, merges, addedLines: added, deletedLines: deleted },
        trackedFiles: tracked,
        authors: [...authors.entries()]
            .map(([name, count]) => ({ name, commits: count }))
            .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name)),
        firstCommitAt: times.length ? isoDate(Math.min(...times)) : null,
        lastCommitAt: times.length ? isoDate(Math.max(...times)) : null,
    };
}

function analyzeDeletions(state) {
    const { repo, order, commits, allTimes, opts } = state;
    const buckets = {
        lt1h: 0,
        lt6h: 0,
        lt1d: 0,
        lt3d: 0,
        lt7d: 0,
        lt14d: 0,
        gte14d: 0,
        unknown: 0,
    };
    const byArea = new Map(AREAS.map((area) => [area, { deleted: 0, young: 0 }]));
    const examples = [];
    let analyzed = 0;

    order.forEach((sha, index) => {
        progress(state, "deletions", index + 1, order.length);
        const commit = commits.get(sha);
        const parent = revParse(repo, `${sha}^`);
        if (!parent) return;
        for (const [path, file] of commit.files) {
            if (file.del === 0) continue;
            const area = classifyPath(path);
            const record = byArea.get(area) ?? byArea.get("other");
            record.deleted += file.del;
            if (isExcluded(path, opts.exclude)) continue;
            const blame = blameLines(state, parent, path);
            for (const range of deletedRanges(repo, parent, sha, path)) {
                for (let line = range.start; line < range.start + range.count; line += 1) {
                    const owner = blame.get(line);
                    if (!owner) {
                        buckets.unknown += 1;
                        continue;
                    }
                    analyzed += 1;
                    const age = commit.time - (allTimes.get(owner) ?? commit.time);
                    const bucket = ageBucket(age);
                    buckets[bucket] += 1;
                    if (bucket === "lt1d") record.young += 1;
                    if (age < 86400 && examples.length < opts.top * 6) {
                        examples.push({
                            ageHours: round(age / 3600, 2),
                            path,
                            area,
                            introducedBy: truncate(commitSubject(state, owner)),
                            removedBy: truncate(commit.subject),
                        });
                    }
                }
            }
        }
    });
    finishProgress(state, "deletions");

    const young = buckets.lt1h + buckets.lt6h + buckets.lt1d;
    return {
        analyzedLines: analyzed,
        youngShare: share(young, analyzed),
        buckets,
        byArea: Object.fromEntries(byArea),
        examples: examples.sort((a, b) => a.ageHours - b.ageHours).slice(0, opts.top),
    };
}

function ageBucket(seconds) {
    if (seconds < 3600) return "lt1h";
    if (seconds < 21600) return "lt6h";
    if (seconds < 86400) return "lt1d";
    if (seconds < 3 * 86400) return "lt3d";
    if (seconds < 7 * 86400) return "lt7d";
    if (seconds < 14 * 86400) return "lt14d";
    return "gte14d";
}

function commitSubject(state, sha) {
    const cached = state.subjects.get(sha);
    if (cached !== undefined) return cached;
    const subject = git(state.repo, ["show", "-s", "--format=%s", sha]).stdout.trim();
    state.subjects.set(sha, subject);
    return subject;
}

function analyzeRework(state) {
    const { repo, order, commits, opts } = state;
    const lastNonFix = new Map();
    const filePairs = [];

    for (const sha of order) {
        const commit = commits.get(sha);
        const isFix = opts.fixTypes.includes(commit.type);
        for (const path of commit.files.keys()) {
            const previous = lastNonFix.get(path);
            if (isFix && previous) {
                const hours = (commit.time - previous.time) / 3600;
                if (hours >= 0 && hours <= opts.reworkWindowHours) {
                    filePairs.push({ path, hours, previous, commit });
                }
            }
            if (!isFix) {
                lastNonFix.set(path, {
                    sha,
                    time: commit.time,
                    subject: commit.subject,
                    type: commit.type,
                });
            }
        }
    }

    const events = new Map();
    for (const pair of filePairs) {
        const key = `${pair.previous.sha}\u0000${pair.commit.sha}`;
        const existing = events.get(key);
        if (existing) existing.paths.push(pair.path);
        else events.set(key, { ...pair, paths: [pair.path] });
    }
    // Cap chronologically so the sample stays representative, then rank for examples.
    const verified = [...events.values()].slice(0, opts.maxFilePairs);

    const byEarlierType = new Map();
    const byArea = new Map();
    const latencies = [];
    const examples = [];
    let sameBranch = 0;
    let crossBranch = 0;

    verified.forEach((event, index) => {
        progress(state, "self-rework", index + 1, verified.length);
        const ancestor =
            git(repo, ["merge-base", "--is-ancestor", event.previous.sha, event.commit.sha], {
                allowFailure: true,
            }).status === 0;
        let continuous = false;
        if (ancestor) {
            const merges = Number(
                git(repo, [
                    "rev-list",
                    "--count",
                    "--merges",
                    `${event.previous.sha}..${event.commit.sha}`,
                ]).stdout.trim() || "0",
            );
            continuous = merges === 0;
        }
        if (continuous) sameBranch += 1;
        else crossBranch += 1;

        latencies.push(event.hours);
        const type = event.previous.type;
        byEarlierType.set(type, (byEarlierType.get(type) ?? 0) + 1);
        for (const path of event.paths) {
            const area = classifyPath(path);
            byArea.set(area, (byArea.get(area) ?? 0) + 1);
        }
        if (examples.length < opts.top) {
            examples.push({
                hours: round(event.hours, 2),
                sameBranch: continuous,
                path: event.paths[0],
                paths: event.paths.length,
                earlierSubject: truncate(event.previous.subject),
                fixSubject: truncate(event.commit.subject),
            });
        }
    });
    finishProgress(state, "self-rework");

    return {
        events: verified.length,
        filePairs: filePairs.length,
        sameBranch,
        crossBranch,
        medianLatencyHours: round(median(latencies), 2),
        p90LatencyHours: round(percentile(latencies, 0.9), 2),
        byEarlierType: Object.fromEntries([...byEarlierType].sort((a, b) => b[1] - a[1])),
        byArea: Object.fromEntries([...byArea].sort((a, b) => b[1] - a[1])),
        examples: examples.sort((a, b) => a.hours - b.hours),
    };
}

function isExcluded(path, patterns) {
    return patterns.some((pattern) => pattern.test(path));
}

function analyzeRewrites(state) {
    const { repo, opts } = state;
    const result = git(repo, ["fsck", "--unreachable", "--no-reflogs", "--no-progress"], {
        allowFailure: true,
    });
    if (result.status !== 0) {
        return { scanned: false, reason: truncate(result.stderr.trim() || "git fsck failed", 200) };
    }
    const unreachable = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("unreachable commit "))
        .map((line) => line.slice("unreachable commit ".length).trim());
    // A rewrite is visible through three cheap signals: the same subject (reworded
    // message, same content), the same tree (amended content, new message), or the same
    // author timestamp (amend keeps it while the committer timestamp moves).
    const reachableSubjects = new Set();
    const reachableTrees = new Set();
    const reachableAuthorTimes = new Set();
    for (const line of git(repo, ["log", "--all", "--format=%H%x1f%s%x1f%T%x1f%at"]).stdout.split(
        "\n",
    )) {
        const [sha, subject, tree, authorTime] = line.split("\u001f");
        if (!sha) continue;
        reachableSubjects.add(subject);
        reachableTrees.add(tree);
        reachableAuthorTimes.add(authorTime);
    }

    let amend = 0;
    let stash = 0;
    let abandoned = 0;
    const abandonedExamples = [];
    for (const sha of unreachable) {
        const [subject, time, authorTime, tree] = git(repo, [
            "show",
            "-s",
            "--format=%s%x1f%ct%x1f%at%x1f%T",
            sha,
        ])
            .stdout.trim()
            .split("\u001f");
        if (/^(WIP on|index on) /.test(subject)) {
            stash += 1;
        } else if (
            reachableSubjects.has(subject) ||
            reachableTrees.has(tree) ||
            reachableAuthorTimes.has(authorTime)
        ) {
            amend += 1;
        } else {
            abandoned += 1;
            if (abandonedExamples.length < opts.top) {
                abandonedExamples.push({ at: isoDate(Number(time)), subject: truncate(subject) });
            }
        }
    }
    return {
        scanned: true,
        unreachableCommits: unreachable.length,
        rewrittenBeforeLanded: amend,
        stashArtifacts: stash,
        abandoned,
        abandonedExamples: abandonedExamples.sort((a, b) => a.at.localeCompare(b.at)),
    };
}

function analyzeSurvival(state) {
    const { repo, order, commits, opts } = state;
    const headFiles = new Set(
        git(repo, ["ls-tree", "-r", "--name-only", state.headSha])
            .stdout.split("\n")
            .filter(Boolean),
    );
    const rows = [];
    order.forEach((sha, index) => {
        progress(state, "survival", index + 1, order.length);
        const commit = commits.get(sha);
        let added = 0;
        for (const file of commit.files.values()) added += file.add;
        if (added < opts.minSurvivalLines) return;
        let kept = 0;
        for (const [path, file] of commit.files) {
            if (file.add === 0 || !headFiles.has(path)) continue;
            for (const owner of blameLines(state, state.headSha, path).values()) {
                if (owner === sha) kept += 1;
            }
        }
        rows.push({
            sha: sha.slice(0, 8),
            subject: truncate(commit.subject),
            added,
            kept,
            ratio: round(kept / added),
        });
    });
    finishProgress(state, "survival");
    const ratios = rows.map((row) => row.ratio);
    return {
        samples: rows.length,
        mean: round(ratios.reduce((sum, value) => sum + value, 0) / Math.max(rows.length, 1)),
        medianRatio: round(median(ratios)),
        worst: [...rows].sort((a, b) => a.ratio - b.ratio).slice(0, opts.top),
    };
}

function analyzeHotspots(state) {
    const { order, commits, opts } = state;
    const touches = new Map();
    for (const sha of order) {
        for (const path of commits.get(sha).files.keys()) {
            const entry = touches.get(path) ?? { path, count: 0, area: classifyPath(path) };
            entry.count += 1;
            touches.set(path, entry);
        }
    }
    const ranked = [...touches.values()].sort(
        (a, b) => b.count - a.count || a.path.localeCompare(b.path),
    );
    const pick = (area) => ranked.filter((entry) => entry.area === area).slice(0, opts.top);
    return {
        code: pick("code"),
        bookkeeping: pick("bookkeeping"),
        docs: pick("docs"),
        mostTouched: ranked[0] ?? null,
    };
}

function analyzePullRequests(state) {
    const { repo, opts } = state;
    const result = spawnSync(
        "gh",
        [
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            String(opts.prLimit),
            "--json",
            "number,state,createdAt,mergedAt,additions,deletions,commits",
        ],
        { cwd: repo, encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } },
    );
    if (result.error || result.status !== 0) {
        throw new MetricError(
            `gh pr list failed: ${truncate((result.stderr || result.error?.message || "").trim(), 300)}`,
            EXIT.tool,
        );
    }
    const pulls = JSON.parse(result.stdout);
    const merged = pulls.filter((pull) => pull.state === "MERGED");
    const commitCounts = merged.map((pull) => (pull.commits ?? []).length);
    const sizes = merged.map((pull) => (pull.additions ?? 0) + (pull.deletions ?? 0));
    const latencies = merged
        .filter((pull) => pull.mergedAt)
        .map((pull) => (Date.parse(pull.mergedAt) - Date.parse(pull.createdAt)) / 3_600_000);
    return {
        total: pulls.length,
        merged: merged.length,
        closed: pulls.filter((pull) => pull.state === "CLOSED").length,
        open: pulls.filter((pull) => pull.state === "OPEN").length,
        medianCommitsPerPull: round(median(commitCounts), 2),
        medianChangedLines: round(median(sizes), 0),
        medianHoursToMerge: round(median(latencies), 2),
        singleCommitPulls: commitCounts.filter((count) => count === 1).length,
        largePulls: merged
            .filter((pull) => (pull.commits ?? []).length >= 5)
            .map((pull) => ({ number: pull.number, commits: pull.commits.length }))
            .sort((a, b) => b.commits - a.commits)
            .slice(0, opts.top),
    };
}

// ---------------------------------------------------------------- progress

function progress(state, label, index, total) {
    if (state.opts.quiet) return;
    const text = `${label} ${index}/${total}`;
    if (process.stderr.isTTY) {
        process.stderr.write(`\r${text.padEnd(40)}`);
    } else if (index === total || index % 25 === 0) {
        process.stderr.write(`${text}\n`);
    }
}

function finishProgress(state) {
    if (state.opts.quiet) return;
    if (process.stderr.isTTY) process.stderr.write(`\r${" ".repeat(42)}\r`);
    else process.stderr.write("\n");
}

// ---------------------------------------------------------------- reporting

function formatHuman(report) {
    const lines = [];
    const push = (line = "") => lines.push(line);
    const { overview, deletions, selfRework, rewrites, survival, hotspots, pullRequests } = report;

    push(
        `${TOOL_NAME} ${TOOL_VERSION} — ${report.repo.name} at ${report.repo.head} (${report.repo.branch})`,
    );
    push(
        `range: ${report.config.range ?? report.config.head} — ${number(overview.commits.analyzed)} commits analyzed, ` +
            `${number(overview.commits.merges)} merges, ${number(report.repo.trackedFiles)} tracked files`,
    );
    push(
        `read-only: ${report.readOnly.gitMetadataUnchanged ? "verified (git metadata unchanged)" : "FAILED"}`,
    );
    if (report.config.truncated) push(`warning: newest ${report.config.maxCommits} commits only`);
    push();

    push(
        `DELETIONS  ${number(deletions.analyzedLines)} lines analyzed of ${number(overview.commits.deletedLines)} removed`,
    );
    const areaBits = AREAS.filter((area) => deletions.byArea[area].deleted > 0).map(
        (area) =>
            `${area} ${number(deletions.byArea[area].deleted)} (${pct(
                share(deletions.byArea[area].deleted, overview.commits.deletedLines),
            )})`,
    );
    push(`  by area      ${areaBits.join("  ")}`);
    push(
        `  code age     ${Object.entries(deletions.buckets)
            .filter(([bucket]) => bucket !== "unknown")
            .map(
                ([bucket, count]) =>
                    `${AGE_LABELS[bucket]} ${pct(share(count, deletions.analyzedLines))}`,
            )
            .join("  ")}`,
    );
    push(`  young share (<1d): ${pct(deletions.youngShare)}`);
    for (const example of deletions.examples.slice(0, 3)) {
        push(`    ${example.ageHours}h  ${example.path}`);
        push(`      wrote:   ${example.introducedBy}`);
        push(`      removed: ${example.removedBy}`);
    }
    push();

    push(
        `SELF-REWORK  ${number(selfRework.events)} fix events within ${report.config.reworkWindowHours}h ` +
            `(${number(selfRework.filePairs)} file pairs)`,
    );
    push(
        `  continuity   same branch ${number(selfRework.sameBranch)}  cross branch ${number(
            selfRework.crossBranch,
        )}`,
    );
    push(
        `  latency      median ${selfRework.medianLatencyHours}h  p90 ${selfRework.p90LatencyHours}h`,
    );
    const typeBits = Object.entries(selfRework.byEarlierType).map(
        ([type, count]) => `${type} ${number(count)}`,
    );
    push(`  previous type ${typeBits.join("  ") || "none"}`);
    for (const example of selfRework.examples.slice(0, 3)) {
        push(`    ${example.hours}h  ${example.earlierSubject}`);
        push(`      fixed by: ${example.fixSubject}`);
    }
    push();

    if (rewrites.scanned) {
        push(`REWRITES  ${number(rewrites.unreachableCommits)} unreachable commits`);
        push(
            `  rewritten before landing ${number(rewrites.rewrittenBeforeLanded)}  ` +
                `stash artifacts ${number(rewrites.stashArtifacts)}  abandoned ${number(rewrites.abandoned)}`,
        );
    } else {
        push(`REWRITES  skipped (${rewrites.reason})`);
    }
    push();

    if (survival) {
        push(
            `SURVIVAL  ${number(survival.samples)} commits — mean ${pct(survival.mean)}, median ${pct(
                survival.medianRatio,
            )} of added lines still present`,
        );
        for (const row of survival.worst.slice(0, 3)) {
            push(`    ${pct(row.ratio)}  +${row.added} keep=${row.kept}  ${row.subject}`);
        }
    } else {
        push("SURVIVAL  skipped");
    }
    push();

    push("HOTSPOTS");
    for (const entry of hotspots.code.slice(0, 5))
        push(`  code         ${entry.count}x  ${entry.path}`);
    for (const entry of hotspots.bookkeeping.slice(0, 3)) {
        push(`  bookkeeping  ${entry.count}x  ${entry.path}`);
    }
    push();

    if (report.caveats.length > 0) {
        push("CAVEATS");
        for (const caveat of report.caveats) push(`  - ${caveat}`);
    }

    if (pullRequests) {
        push(
            `PULL REQUESTS  ${number(pullRequests.total)} total — merged ${number(
                pullRequests.merged,
            )}, closed ${number(pullRequests.closed)}, open ${number(pullRequests.open)}`,
        );
        push(
            `  median commits/PR ${pullRequests.medianCommitsPerPull}  median changed lines ${number(
                pullRequests.medianChangedLines,
            )}  median hours to merge ${pullRequests.medianHoursToMerge}`,
        );
    }

    return `${lines.join("\n")}\n`;
}

function historyDays(inventory) {
    if (!inventory.firstCommitAt || !inventory.lastCommitAt) return 0;
    const span = Date.parse(inventory.lastCommitAt) - Date.parse(inventory.firstCommitAt);
    return span / 86_400_000;
}

function buildCaveats(state, inventory, deletions, selfRework, rewrites, survival) {
    const { opts, truncated } = state;
    const caveats = [];
    const days = historyDays(inventory);
    if (days < 30) {
        caveats.push(
            `history spans ${days.toFixed(1)} days, so every age bucket up to 14d covers the whole history; ` +
                "compare young-share against runs on similarly young history, not against a mature repository",
        );
    }
    if (inventory.commits.analyzed === 0) {
        caveats.push("the analyzed range contains no non-merge commits");
    }
    if (truncated.commits) {
        caveats.push(`only the newest ${opts.maxCommits} commits were analyzed`);
    }
    if (truncated.blame) {
        caveats.push(
            `git blame hit the ${opts.maxBlameCalls} call cap, so deletion ages and survival are partial`,
        );
    }
    if (deletions.analyzedLines < inventory.commits.deletedLines) {
        caveats.push(
            `${number(inventory.commits.deletedLines - deletions.analyzedLines)} removed lines could not ` +
                "be attributed to a commit and are excluded from the age buckets",
        );
    }
    if (survival && survival.samples < 10) {
        caveats.push(
            `survival rests on ${survival.samples} samples; treat the mean as indicative only`,
        );
    }
    if (selfRework.crossBranch > selfRework.sameBranch) {
        caveats.push("most fix-after-change pairs cross a branch or merge boundary");
    }
    if (rewrites.scanned && rewrites.unreachableCommits === 0) {
        caveats.push(
            "no unreachable commits were found, so rewritten-before-landing is zero by construction " +
                "on a fresh clone rather than evidence of a clean history",
        );
    }
    return caveats;
}

function buildReport(state) {
    const { opts } = state;
    const target = opts.range ?? opts.head;
    const inventory = analyzeInventory(state, target);
    const deletions = analyzeDeletions(state);
    const selfRework = analyzeRework(state);
    const rewrites = opts.rewrites
        ? analyzeRewrites(state)
        : { scanned: false, reason: "--no-rewrites" };
    const survival = opts.survival ? analyzeSurvival(state) : null;
    const hotspots = analyzeHotspots(state);
    const pullRequests = opts.pullRequests ? analyzePullRequests(state) : null;

    const report = {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        repo: {
            name: state.repoName,
            head: state.headSha.slice(0, 8),
            branch: state.branch,
            trackedFiles: inventory.trackedFiles,
        },
        config: {
            range: opts.range,
            head: opts.head,
            since: opts.since,
            until: opts.until,
            exclude: opts.excludeRaw,
            reworkWindowHours: opts.reworkWindowHours,
            fixTypes: opts.fixTypes,
            maxCommits: opts.maxCommits,
            truncated: state.truncated.commits,
            blameTruncated: state.truncated.blame,
        },
        readOnly: state.readOnly,
        overview: {
            commits: inventory.commits,
            authors: inventory.authors,
            firstCommitAt: inventory.firstCommitAt,
            lastCommitAt: inventory.lastCommitAt,
            historyDays: round(historyDays(inventory), 1),
        },
        caveats: buildCaveats(state, inventory, deletions, selfRework, rewrites, survival),
        deletions,
        selfRework,
        rewrites,
        survival,
        hotspots,
        pullRequests,
    };
    if (opts.timestamp) report.generatedAt = new Date().toISOString();
    return report;
}

// ---------------------------------------------------------------- entry point

function main(argv) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: CLI,
            strict: true,
            allowPositionals: false,
        }));
    } catch (error) {
        process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
        return EXIT.usage;
    }
    if (values.help) {
        process.stdout.write(HELP);
        return EXIT.ok;
    }

    const opts = {
        range: values.range ? assertRevision(values.range, "--range") : null,
        head: assertRevision(values.head, "--head"),
        since: values.since ?? null,
        until: values.until ?? null,
        json: values.json,
        output: values.output ?? null,
        top: parsePositive(values.top, "--top"),
        reworkWindowHours: parsePositive(
            values["rework-window-hours"],
            "--rework-window-hours",
            true,
        ),
        fixTypes: values["fix-types"]
            .split(",")
            .map((type) => type.trim())
            .filter(Boolean),
        maxCommits: parsePositive(values["max-commits"], "--max-commits"),
        maxBlameCalls: parsePositive(values["max-blame-calls"], "--max-blame-calls"),
        maxFilePairs: parsePositive(values["max-file-pairs"], "--max-file-pairs"),
        minSurvivalLines: parsePositive(values["min-survival-lines"], "--min-survival-lines"),
        excludeRaw: values.exclude ?? [],
        exclude: (values.exclude ?? []).map(globToRegExp),
        rewrites: !values["no-rewrites"],
        survival: !values["no-survival"],
        selfCheck: values["self-check"],
        pullRequests: values["pull-requests"],
        prLimit: parsePositive(values["pr-limit"], "--pr-limit"),
        timestamp: values.timestamp,
        quiet: values.quiet,
    };
    if (!["strict", "warn", "off"].includes(opts.selfCheck)) {
        process.stderr.write(`invalid --self-check: ${opts.selfCheck}\n`);
        return EXIT.usage;
    }
    if (opts.fixTypes.length === 0) {
        process.stderr.write("--fix-types must list at least one commit type\n");
        return EXIT.usage;
    }
    if (opts.output && !existsSync(dirname(resolve(opts.output)))) {
        process.stderr.write(`--output directory does not exist: ${opts.output}\n`);
        return EXIT.usage;
    }

    const candidate = resolve(values.repo ?? process.cwd());
    const check = git(candidate, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    if (check.status !== 0 || check.stdout.trim() !== "true") {
        process.stderr.write(`${candidate} is not a git work tree\n`);
        return EXIT.usage;
    }
    const repo = git(candidate, ["rev-parse", "--show-toplevel"]).stdout.trim();
    let outputPath = null;
    if (opts.output) {
        outputPath = resolve(opts.output);
        if (!relative(repo, outputPath).startsWith("..")) {
            throw new MetricError(
                `refusing to write inside the repository: ${outputPath} (use a path outside it)`,
                EXIT.usage,
            );
        }
    }

    const before = opts.selfCheck === "off" ? [] : fingerprintGitMetadata(repo);
    const target = opts.range ?? opts.head;
    const headSha = revParse(repo, opts.range ? target.split("..").pop() : opts.head);
    if (!headSha) {
        process.stderr.write(`cannot resolve revision: ${target}\n`);
        return EXIT.usage;
    }
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    const commits = readCommits(repo, target, opts);
    const { order, truncated } = readOrder(repo, target, opts.maxCommits);

    const state = {
        repo,
        repoName: repo.slice(repo.lastIndexOf("/") + 1),
        headSha,
        branch,
        opts,
        commits,
        order,
        allTimes: readCommitTimes(repo),
        blameCache: new Map(),
        blameCalls: 0,
        subjects: new Map(),
        truncated: { commits: truncated, blame: false },
        readOnly: { checked: opts.selfCheck !== "off", gitMetadataUnchanged: true, changes: [] },
    };
    if (truncated) {
        process.stderr.write(
            `warning: analyzing the newest ${opts.maxCommits} of ${order.length} commits\n`,
        );
    }

    const report = buildReport(state);

    if (opts.selfCheck !== "off") {
        const after = fingerprintGitMetadata(repo);
        const changes = diffFingerprints(before, after);
        report.readOnly.gitMetadataUnchanged = changes.length === 0;
        report.readOnly.changes = changes.slice(0, 20);
        if (changes.length > 0) {
            process.stderr.write(`read-only self-check failed:\n${changes.join("\n")}\n`);
            if (opts.selfCheck === "strict") return EXIT.readOnlyViolation;
        }
    }

    if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report));
    return EXIT.ok;
}

function parsePositive(value, label, allowFraction = false) {
    const parsed = Number(value);
    const valid =
        Number.isFinite(parsed) && parsed > 0 && (allowFraction || Number.isInteger(parsed));
    if (!valid) {
        throw new MetricError(`invalid ${label}: ${JSON.stringify(value)}`, EXIT.usage);
    }
    return parsed;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    if (error instanceof MetricError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.code;
    } else {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = EXIT.tool;
    }
}
