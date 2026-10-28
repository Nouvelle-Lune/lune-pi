#!/usr/bin/env node
/**
 * Regression cases for the review workflow.
 *
 * A case records a defect the workflow missed, the diff that contained it, and the
 * finding a good reviewer should have produced. Replaying cases is how a change to
 * REVIEW.md, the reviewer contract, or the tier config is judged before it is kept.
 *
 * Read-only: this script never writes to the repository.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const TOOL_VERSION = "1.0.0";
const EXIT = { ok: 0, usage: 2, rule: 4 };

const STATUS = ["open", "fixed", "regressed", "retired"];
const LAYER = ["verification", "review", "ci", "rules"];
const SEVERITY = ["important", "nit"];
const CASE_ID = /^case-[a-z0-9][a-z0-9-]{2,60}$/;

class CaseError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const HELP = `review-cases ${TOOL_VERSION} — replayable review regression cases

Commands
  list                  list cases with status and class
  check                 validate every case file
  show <id>             print one case as JSON
  prompt <id>           print the replay payload for a reviewer

Options
  --repo <path>         repository (default: current directory)
  --cases-dir <path>    case directory (default: <repo>/review-workflow/cases)
  --json                machine-readable output
  --help                show this help

Exit codes
  0  command completed
  2  usage error
  4  a case file is invalid
`;

function fail(message, code = EXIT.usage) {
    throw new CaseError(message, code);
}

function readCases(casesDir) {
    if (!existsSync(casesDir)) fail(`case directory not found: ${casesDir}`);
    return readdirSync(casesDir)
        .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
        .map((name) => {
            const path = join(casesDir, name);
            try {
                return { ...JSON.parse(readFileSync(path, "utf8")), file: name };
            } catch (error) {
                fail(`${name}: invalid JSON (${error.message})`, EXIT.rule);
            }
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function validate(entry) {
    const problems = [];
    const require = (condition, message) => {
        if (!condition) problems.push(message);
    };
    require(entry.schemaVersion === 1, "schemaVersion must be 1");
    require(typeof entry.id === "string" &&
        CASE_ID.test(entry.id), "id must look like case-<slug>");
    require(typeof entry.title === "string" && entry.title.length >= 8, "title is required");
    require(STATUS.includes(entry.status), `status must be one of ${STATUS.join(", ")}`);
    require(LAYER.includes(entry.layer), `layer must be one of ${LAYER.join(", ")}`);
    require(typeof entry.class === "string" &&
        /^[a-z0-9-]{2,40}$/.test(entry.class), "class is required");
    require(typeof entry.signal === "string" && entry.signal.length > 0, "signal is required");
    require(/^\d{4}-\d{2}-\d{2}$/.test(entry.observedAt ?? ""), "observedAt must be YYYY-MM-DD");
    require(typeof entry.diff === "string" && entry.diff.includes("@@"), "diff must contain hunks");
    const missed = entry.missed ?? {};
    require(typeof missed.summary === "string" &&
        missed.summary.length > 0, "missed.summary is required");
    require(typeof missed.file === "string" && missed.file.length > 0, "missed.file is required");
    require(Number.isInteger(missed.line) && missed.line > 0, "missed.line must be positive");
    const expected = entry.expected ?? {};
    require(SEVERITY.includes(expected.severity), "expected.severity must be important or nit");
    require(typeof expected.class === "string" &&
        expected.class.length > 0, "expected.class is required");
    const fix = entry.fix ?? {};
    require(typeof fix.artifact === "string" &&
        fix.artifact.length > 0, "fix.artifact is required");
    require(typeof fix.change === "string" && fix.change.length > 0, "fix.change is required");
    return problems;
}

function main(argv) {
    const command = argv[0];
    if (!command || command === "help" || command === "--help") {
        process.stdout.write(HELP);
        return EXIT.ok;
    }
    let values;
    let positionals;
    try {
        ({ values, positionals } = parseArgs({
            args: argv.slice(1),
            options: {
                repo: { type: "string" },
                "cases-dir": { type: "string" },
                json: { type: "boolean", default: false },
                help: { type: "boolean", default: false },
            },
            strict: true,
            allowPositionals: true,
        }));
    } catch (error) {
        process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
        return EXIT.usage;
    }
    const repo = resolve(values.repo ?? process.cwd());
    const casesDir = values["cases-dir"]
        ? resolve(values["cases-dir"])
        : join(repo, "review-workflow", "cases");
    const cases = readCases(casesDir);

    if (command === "list") {
        if (values.json) {
            process.stdout.write(
                `${JSON.stringify(
                    cases.map((entry) => ({
                        id: entry.id,
                        status: entry.status,
                        layer: entry.layer,
                        class: entry.class,
                    })),
                    null,
                    2,
                )}\n`,
            );
            return EXIT.ok;
        }
        for (const entry of cases) {
            process.stdout.write(
                `${entry.id}  ${entry.status.padEnd(9)} ${entry.class.padEnd(18)} ${entry.title}\n`,
            );
        }
        return EXIT.ok;
    }

    if (command === "check") {
        const failures = [];
        const seen = new Set();
        for (const entry of cases) {
            if (seen.has(entry.id)) failures.push(`${entry.file}: duplicate id ${entry.id}`);
            seen.add(entry.id);
            for (const problem of validate(entry)) failures.push(`${entry.file}: ${problem}`);
        }
        if (failures.length > 0) {
            for (const failure of failures) process.stderr.write(`${failure}\n`);
            return EXIT.rule;
        }
        process.stdout.write(`${cases.length} case(s) valid\n`);
        return EXIT.ok;
    }

    const id = positionals[0];
    if (!id) fail(`${command} needs a case id`, EXIT.usage);
    const entry = cases.find((candidate) => candidate.id === id || candidate.file === `${id}.json`);
    if (!entry) fail(`no case ${id} in ${casesDir}`, EXIT.rule);

    if (command === "show") {
        process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        return EXIT.ok;
    }
    if (command === "prompt") {
        const payload = {
            mode: "replay",
            case: entry.id,
            contract: join(repo, "review-workflow", "reviewer", "CONTRACT.md"),
            reviewFile: join(repo, "review-workflow", "REVIEW.md"),
            instructions: [
                "Review only the diff below, as a reviewer with fresh context would.",
                "Return the JSON findings array exactly as the contract requires.",
                "Do not read the expected block; the harness compares it for you.",
            ],
            files: [entry.missed.file],
            diff: entry.diff,
            expected: entry.expected,
            missed: entry.missed,
        };
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return EXIT.ok;
    }
    fail(`unknown command: ${command}`);
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    if (error instanceof CaseError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.code;
    } else {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = EXIT.rule;
    }
}
