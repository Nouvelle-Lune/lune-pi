#!/usr/bin/env node
/**
 * Review round state machine for the review workflow.
 *
 * The ledger is the authority on how many review rounds a change has had, what each
 * round looked at, which findings are still open, and whether the loop is still
 * converging. Agents ask this script what to review next; the script refuses anything
 * that would break the rules, so convergence does not depend on prompt compliance.
 *
 * Git access is read-only (see GIT_RULES). The only writes are JSON ledger files under
 * the ledger directory.
 */
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const TOOL_VERSION = "1.0.0";
const LEDGER_SCHEMA = 1;

const EXIT = {
    ok: 0,
    usage: 2,
    git: 3,
    rule: 4,
    state: 5,
};

class RoundError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "RoundError";
        this.code = code;
    }
}

const CLI = {
    repo: { type: "string" },
    change: { type: "string" },
    base: { type: "string" },
    head: { type: "string", default: "HEAD" },
    intent: { type: "string" },
    tier: { type: "string" },
    findings: { type: "string" },
    id: { type: "string" },
    status: { type: "string" },
    note: { type: "string" },
    reason: { type: "string" },
    "ledger-dir": { type: "string" },
    config: { type: "string" },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
};

const GIT_RULES = {
    "rev-parse": () => true,
    "merge-base": () => true,
    diff: () => true,
    "ls-tree": () => true,
};

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@^~:{}-]*$/;
const CHANGE_ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
const CLASS_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

const HELP = `review-round ${TOOL_VERSION} — review round state machine

Commands
  start   --change <id> [--intent <text>] [--base <rev>]   open a ledger and pick a tier
  next    --change <id>                                     print what to review this round
  ingest  --change <id> --findings <file|->                 record the round's findings
  close   --change <id> --id <finding> --status <s> [--note <text>]
  status  --change <id> [--json]                            show rounds, findings, state
  stats   [--json]                                          aggregate every ledger
  abandon --change <id> --reason <text>                     stop a change without converging

Options
  --repo <path>        repository (default: current directory)
  --change <id>        change identifier, lowercase words with hyphens
  --base <rev>         review base (default: merge-base with origin/dev, then dev)
  --head <rev>         reviewed revision (default: HEAD)
  --intent <text>      what the change is meant to do, given to the reviewer
  --tier <tier>        override auto tier: routine | standard | high
  --findings <path>    JSON array of findings, or - for stdin
  --id <finding>       finding id assigned by ingest
  --status <status>    fixed | rejected | pre-existing
  --note <text>        required for rejected and pre-existing
  --reason <text>      required for abandon
  --ledger-dir <path>  ledger directory (default: <repo>/review-workflow/ledger)
  --config <path>      workflow config (default: <repo>/review-workflow/config.json)
  --json               machine-readable output where supported
  --quiet              suppress progress output
  --help               show this help

Exit codes
  0  command completed
  2  usage error
  3  git command failed
  4  review rule refused the action (round cap, open findings, invalid finding)
  5  ledger state does not allow the command
`;

// ---------------------------------------------------------------- utilities

function fail(message, code = EXIT.usage) {
    throw new RoundError(message, code);
}

function readJson(path, label) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(`cannot read ${label} at ${path}: ${error.message}`, EXIT.usage);
    }
}

function writeJson(path, value) {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 4)}\n`);
    renameSync(temporary, path);
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

function nowIso() {
    return new Date().toISOString();
}

function assertRevision(value, label) {
    if (typeof value !== "string" || !REVISION.test(value)) {
        fail(`invalid ${label}: ${JSON.stringify(value)}`);
    }
    return value;
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
    if (!rule || !rule(rest)) {
        fail(`refusing to run non read-only git command: git ${args.join(" ")}`, EXIT.rule);
    }
    for (const arg of args) {
        if (/^--(exec|ext-diff|output|upload-pack|receive-pack)/.test(arg)) {
            fail(`refusing unsafe git argument: ${arg}`, EXIT.rule);
        }
    }
    const result = spawnSync("git", ["--no-optional-locks", "-C", repo, ...args], {
        env: GIT_ENV,
        encoding: "utf8",
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) fail(`cannot run git: ${result.error.message}`, EXIT.git);
    if (result.status !== 0 && !allowFailure) {
        fail(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`, EXIT.git);
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolveRepo(candidate) {
    const check = git(candidate, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    if (check.status !== 0 || check.stdout.trim() !== "true") {
        fail(`${candidate} is not a git work tree`);
    }
    return git(candidate, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

// ---------------------------------------------------------------- configuration

function loadConfig(path) {
    const config = readJson(path, "workflow config");
    if (config.schemaVersion !== 1) fail(`unsupported config schema: ${config.schemaVersion}`);
    for (const key of ["tiers", "review"]) failIfMissing(config, key, "config");
    return config;
}

function failIfMissing(object, key, label) {
    if (object[key] === undefined) fail(`${label} is missing "${key}"`, EXIT.usage);
}

function tierPolicy(config, tier) {
    const policy = tier === "routine" || tier === "high" ? config.tiers[tier] : null;
    return {
        tier,
        roundCap: policy?.roundCap ?? config.review.roundCap,
        minIndependentReviews: policy?.minIndependentReviews ?? 1,
    };
}

function computeTier(config, files) {
    const high = (config.tiers.high?.paths ?? []).map(globToRegExp);
    const routine = (config.tiers.routine?.paths ?? []).map(globToRegExp);
    const sensitive = files.filter((file) => high.some((pattern) => pattern.test(file)));
    if (sensitive.length > 0) {
        return { tier: "high", reasons: sensitive.slice(0, 10) };
    }
    const routineOnly =
        files.length > 0 && files.every((file) => routine.some((p) => p.test(file)));
    if (routineOnly) return { tier: "routine", reasons: [] };
    return { tier: config.review.defaultTier ?? "standard", reasons: [] };
}

// ---------------------------------------------------------------- ledger

function ledgerPath(context, change) {
    return join(context.ledgerDir, `${change}.json`);
}

function loadLedger(context, change) {
    const path = ledgerPath(context, change);
    if (!existsSync(path)) fail(`no ledger for change "${change}"; run start first`, EXIT.state);
    const ledger = readJson(path, "ledger");
    if (ledger.schemaVersion !== LEDGER_SCHEMA)
        fail(`unsupported ledger schema in ${path}`, EXIT.state);
    return ledger;
}

function saveLedger(context, ledger) {
    writeJson(ledgerPath(context, ledger.change), ledger);
}

function openFindings(ledger) {
    return ledger.findings.filter((finding) => finding.status === "open");
}

function pendingRound(ledger) {
    return ledger.rounds.find((round) => round.status === "pending") ?? null;
}

function requireChange(value) {
    if (typeof value !== "string" || !CHANGE_ID.test(value)) {
        fail(`invalid --change: ${JSON.stringify(value)} (lowercase words with hyphens)`);
    }
    return value;
}

function defaultBase(repo, head) {
    for (const candidate of ["origin/dev", "dev"]) {
        const result = git(repo, ["merge-base", candidate, head], { allowFailure: true });
        if (result.status === 0 && result.stdout.trim() !== "") return result.stdout.trim();
    }
    const parent = git(repo, ["rev-parse", `${head}^`], { allowFailure: true });
    if (parent.status === 0 && parent.stdout.trim() !== "") return parent.stdout.trim();
    fail("cannot infer a review base; pass --base <rev>", EXIT.state);
}

function changedFiles(repo, base, head) {
    const raw = git(repo, ["diff", "--name-only", "--no-renames", `${base}..${head}`]).stdout;
    return raw.split("\n").filter(Boolean);
}

// ---------------------------------------------------------------- commands

function commandStart(context, options) {
    const change = requireChange(options.change);
    const ledgerFile = ledgerPath(context, change);
    if (existsSync(ledgerFile)) fail(`ledger already exists for "${change}"`, EXIT.state);

    const head = assertRevision(options.head, "--head");
    const headSha = git(context.repo, ["rev-parse", head]).stdout.trim();
    const base = options.base
        ? assertRevision(options.base, "--base")
        : defaultBase(context.repo, headSha);
    const baseSha = git(context.repo, ["rev-parse", base]).stdout.trim();
    const files = changedFiles(context.repo, baseSha, headSha);
    if (files.length === 0) {
        fail(
            `the range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)} contains no changed files; ` +
                "pass --base for a different starting point",
            EXIT.state,
        );
    }

    const auto = computeTier(context.config, files);
    const tier = options.tier ?? auto.tier;
    if (!["routine", "standard", "high"].includes(tier)) fail(`invalid --tier: ${tier}`);
    const policy = tierPolicy(context.config, tier);

    const ledger = {
        schemaVersion: LEDGER_SCHEMA,
        change,
        createdAt: nowIso(),
        intent: options.intent ?? null,
        tier,
        tierReasons: options.tier ? ["tier overridden on the command line"] : auto.reasons,
        roundCap: policy.roundCap,
        minIndependentReviews: policy.minIndependentReviews,
        baseRev: baseSha,
        headRev: headSha,
        files,
        state: "open",
        rounds: [],
        findings: [],
    };
    mkdirSync(context.ledgerDir, { recursive: true });
    saveLedger(context, ledger);
    return {
        change,
        tier,
        tierReasons: ledger.tierReasons,
        base: baseSha.slice(0, 8),
        head: headSha.slice(0, 8),
        files: files.length,
        roundCap: ledger.roundCap,
        ledger: relative(context.repo, ledgerFile).startsWith("..")
            ? ledgerFile
            : relative(context.repo, ledgerFile),
    };
}

function commandNext(context, options) {
    const change = requireChange(options.change);
    const ledger = loadLedger(context, change);
    if (ledger.state === "converged")
        fail("the change already converged; nothing to review", EXIT.state);
    if (ledger.state === "abandoned") fail("the change was abandoned", EXIT.state);
    if (pendingRound(ledger)) {
        fail(`round ${pendingRound(ledger).round} is waiting for ingest`, EXIT.state);
    }
    if (context.config.review.requireClosedFindingsBeforeNextRound) {
        const open = openFindings(ledger);
        if (open.length > 0) {
            fail(
                `close ${open.length} open finding(s) before the next round: ` +
                    open.map((finding) => finding.id).join(", "),
                EXIT.rule,
            );
        }
    }
    const round = ledger.rounds.length + 1;
    if (round > ledger.roundCap) {
        ledger.state = "needs-redesign";
        saveLedger(context, ledger);
        fail(
            `round cap reached (${ledger.roundCap}). Stop reviewing and reconsider the approach: ` +
                "narrow the change, split it, or rewrite it. Start a new change id for the new approach.",
            EXIT.rule,
        );
    }

    const head = assertRevision(options.head, "--head");
    const headSha = git(context.repo, ["rev-parse", head]).stdout.trim();
    const diffOnlyAfter = context.config.review.diffOnlyAfterRound ?? 1;
    const scope = round <= diffOnlyAfter ? "full" : "diff-after-previous-round";
    const scopeBase = round === 1 ? ledger.baseRev : ledger.rounds[round - 2].head;
    const files = changedFiles(context.repo, scopeBase, headSha);
    const reviewFile = join(context.repo, "review-workflow", "REVIEW.md");
    const contract = join(context.repo, "review-workflow", "reviewer", "CONTRACT.md");

    let diff = git(context.repo, [
        "diff",
        "--no-color",
        "--no-renames",
        "--unified=3",
        `${scopeBase}..${headSha}`,
    ]).stdout;
    const maxBytes = context.config.review.maxDiffBytes ?? 200_000;
    const truncated = Buffer.byteLength(diff) > maxBytes;
    if (truncated) diff = diff.slice(0, maxBytes);

    ledger.rounds.push({
        round,
        at: nowIso(),
        scope,
        base: scopeBase,
        head: headSha,
        status: "pending",
        findings: 0,
        newFindings: 0,
    });
    saveLedger(context, ledger);

    const swept = new Map();
    for (const finding of ledger.findings) {
        swept.set(finding.class, (swept.get(finding.class) ?? 0) + 1);
    }
    return {
        change,
        round,
        roundCap: ledger.roundCap,
        tier: ledger.tier,
        scope,
        base: scopeBase.slice(0, 8),
        head: headSha.slice(0, 8),
        intent: ledger.intent,
        files,
        diff,
        diffTruncated: truncated,
        contract,
        reviewFile,
        previousClasses: [...swept].map(([name, count]) => ({ class: name, count })),
        rules: [
            "Report only issues introduced by this diff unless preExisting is true.",
            "Every finding needs file and line from the diff; no guessed paths.",
            "Use one finding per class, with every instance listed in the summary.",
            "Style preferences and cleanup that a formatter handles are not findings.",
            "Answer the previous classes above: state fixed, still present, or not applicable.",
        ],
    };
}

function normalizeFinding(raw, index, round, ledger, files, seen) {
    const label = `finding ${index + 1}`;
    if (typeof raw !== "object" || raw === null) fail(`${label} is not an object`, EXIT.rule);
    const severity = raw.severity;
    if (severity !== "important" && severity !== "nit") {
        fail(`${label}: severity must be "important" or "nit"`, EXIT.rule);
    }
    if (typeof raw.class !== "string" || !CLASS_ID.test(raw.class)) {
        fail(`${label}: class must be a lowercase slug such as "missing-guard"`, EXIT.rule);
    }
    if (typeof raw.file !== "string" || raw.file.trim() === "") {
        fail(`${label}: file is required`, EXIT.rule);
    }
    if (!Number.isInteger(raw.line) || raw.line < 1) {
        fail(`${label}: line must be a positive integer`, EXIT.rule);
    }
    if (typeof raw.summary !== "string" || raw.summary.trim() === "") {
        fail(`${label}: summary is required`, EXIT.rule);
    }
    if (raw.summary.length > 400) fail(`${label}: summary exceeds 400 characters`, EXIT.rule);
    const preExisting = raw.preExisting === true;
    if (!preExisting && files.length > 0 && !files.includes(raw.file)) {
        fail(
            `${label}: ${raw.file} is not part of this round; mark preExisting true for old code`,
            EXIT.rule,
        );
    }
    const key = `${raw.file}:${raw.line}:${raw.class}`;
    if (seen.has(key)) {
        return { suppressed: { key, reason: "duplicate within the round" } };
    }
    seen.add(key);
    const prior = ledger.findings.find((finding) => finding.key === key);
    if (prior) {
        return {
            suppressed: {
                key,
                reason:
                    prior.status === "rejected"
                        ? `already rejected in round ${prior.round}`
                        : `already recorded as ${prior.status}`,
                id: prior.id,
            },
        };
    }
    return {
        finding: {
            id: `F${round}-${index + 1}`,
            key,
            round,
            severity,
            class: raw.class,
            file: raw.file,
            line: raw.line,
            summary: raw.summary.trim(),
            preExisting,
            status: "open",
            resolution: null,
            resolvedAt: null,
        },
    };
}

function readFindings(source) {
    let text;
    if (source === "-") {
        text = readFileSync(0, "utf8");
    } else {
        if (!existsSync(source)) fail(`findings file not found: ${source}`);
        text = readFileSync(source, "utf8");
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        fail(`findings are not valid JSON: ${error.message}`, EXIT.rule);
    }
    const list = Array.isArray(parsed) ? parsed : parsed.findings;
    if (!Array.isArray(list))
        fail('findings must be a JSON array or {"findings": [...]}', EXIT.rule);
    return list;
}

function commandIngest(context, options) {
    const change = requireChange(options.change);
    const ledger = loadLedger(context, change);
    const round = pendingRound(ledger);
    if (!round) fail("no pending round; run next first", EXIT.state);
    if (!options.findings) fail("--findings is required");
    const raw = readFindings(options.findings);
    const files = changedFiles(context.repo, round.base, round.head);

    const seen = new Set();
    const accepted = [];
    const suppressed = [];
    raw.forEach((entry, index) => {
        const result = normalizeFinding(entry, index, round.round, ledger, files, seen);
        if (result.suppressed) suppressed.push(result.suppressed);
        else accepted.push(result.finding);
    });

    ledger.findings.push(...accepted);
    round.status = "ingested";
    round.findings = raw.length;
    round.newFindings = accepted.length;
    round.duplicates = suppressed.length;

    if (accepted.length === 0 && suppressed.length === 0) {
        ledger.state = "converged";
        ledger.convergedAt = nowIso();
    }
    saveLedger(context, ledger);

    return {
        change,
        round: round.round,
        accepted: accepted.length,
        suppressed: suppressed.length,
        suppressedDetail: suppressed.slice(0, 10),
        findings: accepted.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            class: finding.class,
            file: finding.file,
            line: finding.line,
        })),
        state: ledger.state,
        next:
            accepted.length === 0
                ? "converged: the change may proceed"
                : `close findings, then run next for diff-only re-review (round cap ${ledger.roundCap})`,
    };
}

function commandClose(context, options) {
    const change = requireChange(options.change);
    const ledger = loadLedger(context, change);
    const finding = ledger.findings.find((entry) => entry.id === options.id);
    if (!finding) fail(`unknown finding: ${options.id}`, EXIT.state);
    if (finding.status !== "open") fail(`${finding.id} is already ${finding.status}`, EXIT.state);
    const status = options.status;
    if (!["fixed", "rejected", "pre-existing"].includes(status)) {
        fail(`invalid --status: ${status} (fixed | rejected | pre-existing)`);
    }
    if ((status === "rejected" || status === "pre-existing") && !options.note) {
        fail(`--note is required when closing as ${status}`, EXIT.rule);
    }
    finding.status = status;
    finding.resolution = options.note ?? null;
    finding.resolvedAt = nowIso();
    if (status === "pre-existing") finding.preExisting = true;
    if (openFindings(ledger).length === 0 && ledger.state === "open") {
        ledger.state = "ready";
    }
    saveLedger(context, ledger);
    return {
        change,
        finding: finding.id,
        status,
        open: openFindings(ledger).length,
        state: ledger.state,
        next:
            openFindings(ledger).length === 0
                ? "run next for a diff-only re-review, or converge if the last round was clean"
                : "close the remaining findings",
    };
}

function commandStatus(context, options) {
    const change = requireChange(options.change);
    const ledger = loadLedger(context, change);
    const counts = {};
    for (const finding of ledger.findings) {
        counts[finding.status] = (counts[finding.status] ?? 0) + 1;
    }
    return {
        change,
        tier: ledger.tier,
        state: ledger.state,
        rounds: ledger.rounds.length,
        roundCap: ledger.roundCap,
        scope: ledger.rounds.map((round) => `${round.round}:${round.scope}`),
        findings: counts,
        open: openFindings(ledger).map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            class: finding.class,
            file: `${finding.file}:${finding.line}`,
            summary: finding.summary,
        })),
        files: ledger.files.length,
    };
}

function commandStats(context) {
    const files = existsSync(context.ledgerDir)
        ? readdirSync(context.ledgerDir).filter((name) => name.endsWith(".json"))
        : [];
    const ledgers = files.map((name) => readJson(join(context.ledgerDir, name), "ledger"));
    const converged = ledgers.filter((ledger) => ledger.state === "converged");
    const rounds = ledgers.map((ledger) => ledger.rounds.length).sort((a, b) => a - b);
    const median = rounds.length === 0 ? 0 : rounds[Math.floor(rounds.length / 2)];
    const findings = ledgers.flatMap((ledger) => ledger.findings);
    const closed = findings.filter((finding) => finding.status !== "open");
    const rejected = findings.filter((finding) => finding.status === "rejected");
    const perRound = ledgers.map((ledger) => ({
        change: ledger.change,
        rounds: ledger.rounds.length,
        findings: ledger.findings.length,
        state: ledger.state,
    }));
    return {
        changes: ledgers.length,
        converged: converged.length,
        needsRedesign: ledgers.filter((ledger) => ledger.state === "needs-redesign").length,
        abandoned: ledgers.filter((ledger) => ledger.state === "abandoned").length,
        openChanges: ledgers.filter((ledger) => ["open", "ready"].includes(ledger.state)).length,
        medianRounds: median,
        roundsToPass: converged.map((ledger) => ledger.rounds.length),
        findings: findings.length,
        findingsPerRound:
            ledgers.length === 0 ? 0 : round(findings.length / Math.max(sum(rounds), 1)),
        rejectionShare: closed.length === 0 ? 0 : round(rejected.length / closed.length),
        preExisting: findings.filter((finding) => finding.preExisting).length,
        perChange: perRound.sort((a, b) => b.rounds - a.rounds || a.change.localeCompare(b.change)),
    };
}

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function commandAbandon(context, options) {
    const change = requireChange(options.change);
    const ledger = loadLedger(context, change);
    if (!options.reason) fail("--reason is required for abandon", EXIT.rule);
    ledger.state = "abandoned";
    ledger.abandonedReason = options.reason;
    ledger.abandonedAt = nowIso();
    saveLedger(context, ledger);
    return { change, state: ledger.state, reason: options.reason };
}

// ---------------------------------------------------------------- output

function formatHuman(command, result) {
    const lines = [];
    const push = (line = "") => lines.push(line);
    if (command === "next") {
        push(
            `round ${result.round}/${result.roundCap} — ${result.change} (${result.tier}, ${result.scope})`,
        );
        push(
            `diff ${result.base}..${result.head}, ${result.files.length} files${result.diffTruncated ? ", truncated" : ""}`,
        );
        push();
        push(`1. Read ${result.contract}`);
        push(`2. Read ${result.reviewFile}`);
        push(`3. Review the diff below and answer every previous class`);
        push("4. Write findings as a JSON array and run:");
        push(
            `   node review-workflow/scripts/review-round.mjs ingest --change ${result.change} ` +
                `--findings /tmp/${result.change}-round${result.round}.json`,
        );
        push();
        if (result.previousClasses.length > 0) {
            push("previous classes");
            for (const entry of result.previousClasses) push(`  ${entry.class} (${entry.count})`);
            push();
        }
        push(result.diff);
        return `${lines.join("\n")}\n`;
    }
    if (command === "ingest") {
        push(
            `round ${result.round} of ${result.change}: ${result.accepted} new, ${result.suppressed} suppressed`,
        );
        for (const finding of result.findings) {
            push(
                `  ${finding.id}  ${finding.severity.padEnd(9)} ${finding.class.padEnd(20)} ${finding.file}:${finding.line}`,
            );
        }
        for (const entry of result.suppressedDetail) {
            push(`  suppressed ${entry.key} — ${entry.reason}`);
        }
        push();
        push(result.next);
        return `${lines.join("\n")}\n`;
    }
    if (command === "status") {
        push(
            `${result.change} — ${result.tier}, state ${result.state}, ${result.rounds}/${result.roundCap} rounds`,
        );
        push(`findings ${JSON.stringify(result.findings)}`);
        if (result.open.length > 0) {
            push("open");
            for (const finding of result.open) {
                push(
                    `  ${finding.id}  ${finding.severity.padEnd(9)} ${finding.class.padEnd(20)} ${finding.file}`,
                );
                push(`        ${finding.summary}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }
    if (command === "stats") {
        push(
            `changes ${result.changes} — converged ${result.converged}, open ${result.openChanges}, ` +
                `needs redesign ${result.needsRedesign}, abandoned ${result.abandoned}`,
        );
        push(
            `median rounds ${result.medianRounds}  findings/round ${result.findingsPerRound}  ` +
                `rejected share ${(result.rejectionShare * 100).toFixed(1)}%`,
        );
        for (const change of result.perChange) {
            push(
                `  ${change.change}: ${change.rounds} rounds, ${change.findings} findings, ${change.state}`,
            );
        }
        return `${lines.join("\n")}\n`;
    }
    return `${JSON.stringify(result, null, 2)}\n`;
}

// ---------------------------------------------------------------- entry point

function main(argv) {
    const command = argv[0];
    if (!command || command === "--help" || command === "help") {
        process.stdout.write(HELP);
        return EXIT.ok;
    }
    let values;
    try {
        ({ values } = parseArgs({
            args: argv.slice(1),
            options: CLI,
            strict: true,
            allowPositionals: false,
        }));
    } catch (error) {
        process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
        return EXIT.usage;
    }

    const repo = resolveRepo(resolve(values.repo ?? process.cwd()));
    const configPath = values.config
        ? resolve(values.config)
        : join(repo, "review-workflow", "config.json");
    if (!existsSync(configPath)) fail(`workflow config not found: ${configPath}`, EXIT.usage);
    const config = loadConfig(configPath);
    const ledgerDir = values["ledger-dir"]
        ? resolve(values["ledger-dir"])
        : join(repo, "review-workflow", "ledger");

    const context = { repo, config, ledgerDir };
    const options = {
        change: values.change,
        base: values.base,
        head: values.head,
        intent: values.intent,
        tier: values.tier,
        findings: values.findings,
        id: values.id,
        status: values.status,
        note: values.note,
        reason: values.reason,
        json: values.json,
    };

    const commands = {
        start: commandStart,
        next: commandNext,
        ingest: commandIngest,
        close: commandClose,
        status: commandStatus,
        stats: commandStats,
        abandon: commandAbandon,
    };
    if (command === "stats") {
        const result = commandStats(context);
        process.stdout.write(
            values.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(command, result),
        );
        return EXIT.ok;
    }
    const handler = commands[command];
    if (!handler) fail(`unknown command: ${command}`);
    const result = handler(context, options);
    process.stdout.write(
        values.json || command === "start" || command === "abandon" || command === "close"
            ? `${JSON.stringify(result, null, 2)}\n`
            : formatHuman(command, result),
    );
    return EXIT.ok;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    if (error instanceof RoundError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.code;
    } else {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = EXIT.state;
    }
}
