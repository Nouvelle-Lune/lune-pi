import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { MEMORY_CONTEXT_TAG, type Harness } from "../core/types.ts";
import { AdapterFormatError, type MemoryPathTest, type SessionFileRef } from "./types.ts";

/** Pi custom message type that carries injected L1 context. */
export const PI_L1_CUSTOM_TYPE = "lune-memory-l1";

const MEMORY_TOOL_NAMES = new Set([
    "transcript_search",
    "note_write",
    "note_update",
    "note_retract",
    "memory_location",
]);

/**
 * True when a tool name is one of the lune-memory tools. MCP clients add a prefix such as
 * `mcp__lune-memory__`, so the check uses the last name segment.
 */
export function isMemoryToolName(name: string | undefined): boolean {
    if (!name) return false;
    const segments = name.split(/__|[.:/]/u);
    const last = segments[segments.length - 1] ?? name;
    return MEMORY_TOOL_NAMES.has(last) || MEMORY_TOOL_NAMES.has(name);
}

const MEMORY_PATH_PATTERN =
    /\.lune-memory[\\/](?:views|transcripts|\.generations|memory\.db)(?![\w.-])/u;

/**
 * True when text references a lune-memory file, for example a file read of L2 or L3. The default
 * home always counts. `test` adds the paths of the home in use, and with `cwd` also the relative
 * paths from that folder.
 */
export function mentionsMemoryPath(
    text: string | undefined,
    test?: MemoryPathTest,
    cwd?: string,
): boolean {
    if (text === undefined) return false;
    return MEMORY_PATH_PATTERN.test(text) || (test?.(text, cwd) ?? false);
}

function trimSeparators(path: string): string {
    return path.replace(/[\\/]+$/u, "");
}

function realpathOr(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** Pattern source for a literal path. A separator matches `/` and `\\`. */
function pathSource(path: string): string {
    return path
        .split(/[\\/]/u)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join("[\\\\/]");
}

/** Quoted shell arguments stay together, including ordinary paths containing spaces. */
const PATH_TOKENS = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s"'`,;|&()<>=]+)/gu;
const FOLDER_WORDS = new Set(["cd", "pushd", "-C", "workdir", "cwd", "dir_path"]);
const PATH_FIELDS = new Set(["path", "file_path", "filePath", "filename", "file", "target"]);
const MAX_TOKEN = 4096;
const MAX_BASES = 16;

interface PathToken {
    value: string;
    folder: boolean;
    explicit: boolean;
}

function pathTokens(text: string): PathToken[] {
    const tokens: PathToken[] = [];
    const command = (value: string): void => {
        let folder = false;
        for (const match of value.matchAll(PATH_TOKENS)) {
            const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\ ])/gu, "$1");
            tokens.push({ value: token, folder, explicit: false });
            folder = FOLDER_WORDS.has(token);
        }
    };
    const visit = (value: unknown, field?: string): void => {
        if (typeof value === "string") {
            if (field && (FOLDER_WORDS.has(field) || PATH_FIELDS.has(field))) {
                tokens.push({ value, folder: FOLDER_WORDS.has(field), explicit: true });
            } else {
                command(value);
            }
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item, field);
        } else if (value && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) visit(item, key);
        }
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        command(text);
        return tokens;
    }
    visit(parsed);
    return tokens;
}

function insideAny(path: string, roots: ReadonlySet<string>): boolean {
    for (const root of roots) {
        if (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
            return true;
        }
    }
    return false;
}

/**
 * True when a relative path in `text` names a memory file from the folder `cwd`, for example
 * `cat ../memory/views/a.md` from a sibling folder. A folder after `cd`, `workdir` or a similar
 * word is a further start folder for all tokens, because JSON arguments do not keep the order of
 * the shell. Absolute paths resolve to themselves, so a read outside memory home does not count
 * when the cwd is memory home.
 */
function namesRelativePath(
    text: string,
    cwd: string,
    roots: ReadonlySet<string>,
    home: string,
    realCwd: (path: string) => string,
): boolean {
    const tokens = pathTokens(text).filter(
        ({ value }) => value !== "" && value.length <= MAX_TOKEN && !value.includes("://"),
    );
    const expand = (token: string): string =>
        token === "~" ? home : token.startsWith("~/") ? join(home, token.slice(2)) : token;
    const bases = new Set([cwd, realCwd(cwd)]);
    for (const token of tokens) {
        if (!token.folder) continue;
        for (const base of [...bases]) {
            if (bases.size >= MAX_BASES) break;
            bases.add(resolve(base, expand(token.value)));
        }
    }
    for (const token of tokens) {
        const value = token.value.replace(/^@/u, "");
        // Bare command names and JSON words are not paths, even when cwd is inside views.
        if (token.folder || FOLDER_WORDS.has(value) || value.startsWith("$")) continue;
        if (!token.explicit && !/[\\/]|\.[\w-]+$|^\.\.?$/u.test(value)) continue;
        const path = expand(value);
        for (const base of bases) {
            if (insideAny(resolve(base, path), roots)) return true;
        }
    }
    return false;
}

/**
 * Test for the memory files below the given paths: each path as given, its real path, and the
 * `~/` and `$HOME/` forms of a path in the user home. A form matches only as a whole path, so
 * `views` does not match `views2`. With a cwd, a relative path that resolves from that folder to
 * one of the paths also counts.
 */
export function memoryPathTest(paths: readonly string[], home = homedir()): MemoryPathTest {
    const homeRoot = trimSeparators(home);
    const forms = new Set<string>();
    const roots = new Set<string>();
    for (const path of paths) {
        for (const variant of [trimSeparators(path), trimSeparators(realpathOr(path))]) {
            if (!variant) continue;
            forms.add(variant);
            if (isAbsolute(variant)) roots.add(resolve(variant));
            if (!homeRoot || !variant.startsWith(homeRoot)) continue;
            const rest = variant.slice(homeRoot.length);
            if (!/^[\\/]/u.test(rest)) continue;
            forms.add(`~${rest}`);
            forms.add(`$HOME${rest}`);
            forms.add(`\${HOME}${rest}`);
        }
    }
    if (forms.size === 0) return () => false;
    const source = [...forms]
        .sort((a, b) => b.length - a.length)
        .map(pathSource)
        .join("|");
    const pattern = new RegExp(`(?:${source})(?![\\w.-])`, "u");
    const realCwds = new Map<string, string>();
    const realCwd = (cwd: string): string => {
        let real = realCwds.get(cwd);
        if (real === undefined) {
            real = realpathOr(cwd);
            realCwds.set(cwd, real);
        }
        return real;
    };
    return (text, cwd) =>
        pattern.test(text) ||
        (cwd !== undefined &&
            isAbsolute(cwd) &&
            roots.size > 0 &&
            namesRelativePath(text, cwd, roots, homeRoot || home, realCwd));
}

/** True when text contains injected L1 context. */
export function containsMemoryContext(text: string | undefined): boolean {
    return text !== undefined && text.includes(`<${MEMORY_CONTEXT_TAG}`);
}

/**
 * True when a tool call is memory-derived: a memory tool, or a call that reads memory files.
 * `cwd` is the working folder of the call, for relative paths.
 */
export function isMemoryToolCall(
    name: string | undefined,
    argumentsText: string,
    test?: MemoryPathTest,
    cwd?: string,
): boolean {
    return isMemoryToolName(name) || mentionsMemoryPath(argumentsText, test, cwd);
}

/** Serialize tool arguments for an event text. Strings stay as they are. */
export function argumentsToText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * Content of a message with a known role: a string or an array of blocks. Any other shape throws.
 * An import that read it as empty would drop the event and so remove its earlier revision (§4).
 */
export function knownContent(content: unknown, where: string): string | unknown[] {
    if (typeof content === "string" || Array.isArray(content)) return content;
    throw new AdapterFormatError(`${where} content has an unknown format`);
}

/**
 * Text of a text block. A text block whose `text` is not a string throws, for the same reason as
 * `knownContent`. `where` names the record in the error.
 */
export function blockText(block: Record<string, unknown> | undefined, where: string): string {
    const text = block?.text;
    if (typeof text === "string") return text;
    throw new AdapterFormatError(`${where} text block has an unknown format`);
}

/**
 * Join the text of content blocks. `content` can be a string or an array of blocks. Only blocks of
 * the given text types are kept, and each must have a string `text` (see `blockText`). Images
 * become a placeholder. `where` names the record in an error.
 */
export function blocksToText(
    content: unknown,
    where: string,
    textTypes: readonly string[] = ["text"],
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const block of content) {
        if (typeof block === "string") {
            parts.push(block);
            continue;
        }
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        if (textTypes.includes(type)) parts.push(blockText(record, where));
        else if (type === "image" || type === "input_image") parts.push("[image]");
        else rejectUnknownTextBlock(record, where);
    }
    return parts.join("\n");
}

/** Unknown text-bearing blocks must fail import before they replace earlier evidence. */
export function rejectUnknownTextBlock(block: unknown, where: string): void {
    const record = obj(block);
    if (!record || record.type === "thinking" || record.type === "redacted_thinking") return;
    const holdsText = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(holdsText);
        const nested = obj(value);
        return (
            nested !== undefined &&
            ("text" in nested || "content" in nested || Object.values(nested).some(holdsText))
        );
    };
    if (holdsText(record)) {
        throw new AdapterFormatError(`${where} text-bearing block has an unknown format`);
    }
}

/** Increment a filter counter. */
export function bump(counter: Record<string, number>, reason: string, by = 1): void {
    counter[reason] = (counter[reason] ?? 0) + by;
}

/** Split JSONL text into lines with 1-based numbers. Empty lines are skipped. */
export function jsonlLines(text: string): Array<{ line: number; raw: string }> {
    const lines = text.split("\n");
    const out: Array<{ line: number; raw: string }> = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]?.trim() ?? "";
        if (raw) out.push({ line: i + 1, raw });
    }
    return out;
}

/**
 * Parse JSONL records. A malformed line is a warning. A malformed last line is expected while
 * the harness writes the file, so it does not create a warning.
 */
export function parseJsonl(
    text: string,
    warnings: string[],
): Array<{ line: number; raw: string; record: Record<string, unknown> }> {
    const lines = jsonlLines(text);
    const out: Array<{ line: number; raw: string; record: Record<string, unknown> }> = [];
    for (let i = 0; i < lines.length; i++) {
        const entry = lines[i];
        if (!entry) continue;
        try {
            const value: unknown = JSON.parse(entry.raw);
            if (value && typeof value === "object" && !Array.isArray(value)) {
                out.push({
                    line: entry.line,
                    raw: entry.raw,
                    record: value as Record<string, unknown>,
                });
            } else {
                warnings.push(`line ${entry.line}: record is not an object`);
            }
        } catch {
            if (i < lines.length - 1 || text.endsWith("\n")) {
                warnings.push(`line ${entry.line}: malformed JSON`);
            }
        }
    }
    return out;
}

/**
 * List session files below `root`: `*.jsonl`, and `*.jsonl.zst` when `compressed` is true.
 * `maxDepth` limits recursion. Missing roots give no files. A symlink counts only when its real
 * path is inside the real path of `root`, so a link cannot import sessions from a directory that
 * is not enabled.
 */
export function findJsonlFiles(
    harness: Harness,
    root: string,
    maxDepth: number,
    compressed = false,
): SessionFileRef[] {
    const out: SessionFileRef[] = [];
    const base = realpathOr(root);
    const inside = (path: string): boolean => {
        const rest = relative(base, path);
        return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
    };
    const walk = (dir: string, depth: number): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            let stat;
            try {
                if (entry.isSymbolicLink() && !inside(realpathSync(path))) continue;
                stat = statSync(path);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (depth < maxDepth) walk(path, depth + 1);
            } else if (
                stat.isFile() &&
                (entry.name.endsWith(".jsonl") || (compressed && entry.name.endsWith(".jsonl.zst")))
            ) {
                out.push({ harness, path, size: stat.size, mtimeMs: stat.mtimeMs });
            }
        }
    };
    walk(root, 0);
    return out;
}

export function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function obj(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
