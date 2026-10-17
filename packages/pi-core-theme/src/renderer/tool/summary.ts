import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fileHref, hyperlinksEnabled } from "../../utils/links.ts";

export function singleLine(value: unknown): string {
    return typeof value === "string"
        ? value
              .replace(/[\r\n\t]+/g, " ")
              .replace(/[\u0000-\u001f\u007f]/g, "")
              .trim()
        : "";
}
// Summaries are styled by their caller, so clipping must not emit ANSI resets that end that style early.
function clip(text: string, width: number): string {
    if (visibleWidth(text) <= width) return text;
    if (width < 1) return "";
    let out = "";
    for (const char of text) {
        if (visibleWidth(out + char) > width - 1) break;
        out += char;
    }
    return `${out.trimEnd()}…`;
}
interface ShellPart {
    tokens: string[];
    // Whether this command receives the previous command's output through a pipe.
    piped: boolean;
}
// Quotes and shell operators delimit a command summary without interpreting or executing shell code.
const MAX_SCANNED = 32_000;
function shellParts(command: string): ShellPart[] {
    const parts: ShellPart[] = [{ tokens: [], piped: false }];
    let token = "";
    let quote = "";
    let piped = false;
    const heredocs: { delimiter: string; indented: boolean }[] = [];
    const flush = () => {
        if (token) parts.at(-1)!.tokens.push(token);
        token = "";
    };
    const source = command;
    // Heredoc bodies are skipped, so only the characters actually scanned count against the cap.
    let scanned = 0;
    for (let index = 0; index < source.length && scanned++ < MAX_SCANNED; index++) {
        const char = source[index]!;
        if (char === "\\" && quote !== "'") {
            token += source[++index] ?? "";
        } else if (quote) {
            if (char === quote) quote = "";
            else token += char;
        } else if (char === "'" || char === '"') quote = char;
        else if (char === "&" && (source[index - 1] === ">" || source[index + 1] === ">")) {
            // Redirections such as 2>&1 and &> are arguments, not command separators.
            token += char;
        } else if (
            char === "<" &&
            source[index + 1] === "<" &&
            source[index + 2] !== "<" &&
            source[index - 1] !== "<"
        ) {
            // A heredoc body is data for the command, not a list of further commands.
            flush();
            let end = index + 2;
            const indented = source[end] === "-";
            if (indented) end++;
            while (source[end] === " " || source[end] === "\t") end++;
            const open = source[end] === "'" || source[end] === '"' ? source[end++]! : "";
            let delimiter = "";
            while (
                end < source.length &&
                (open ? source[end] !== open : !/[\s;|&<>()]/.test(source[end]!))
            )
                delimiter += source[end++];
            if (delimiter) heredocs.push({ delimiter, indented });
            index = open ? end : end - 1;
        } else if (/[;|&\n]/.test(char)) {
            if (char === "\n") {
                for (const { delimiter, indented } of heredocs.splice(0)) {
                    let cursor = index + 1;
                    while (cursor < source.length) {
                        const next = source.indexOf("\n", cursor);
                        const lineEnd = next < 0 ? source.length : next;
                        const line = source.slice(cursor, lineEnd);
                        // Resume on the newline that ends the delimiter line (or at the end of input).
                        index = Math.max(index, lineEnd - 1);
                        cursor = lineEnd + 1;
                        if ((indented ? line.trimStart() : line) === delimiter) break;
                    }
                }
            }
            flush();
            const previous = source[index - 1];
            if (char === "|" && previous !== "|" && source[index + 1] !== "|") piped = true;
            else if (char !== "\n" && !(char === "&" && previous === "|")) piped = false;
            if (parts.at(-1)!.tokens.length) parts.push({ tokens: [], piped });
            parts.at(-1)!.piped = piped;
        } else if (/\s/.test(char)) flush();
        else token += char;
    }
    flush();
    return parts.filter((part) => part.tokens.length);
}
const ARG_WIDTH = 36;
// Paths keep their tail, which names the target; other arguments keep their head.
function fitArg(word: string): string {
    if (visibleWidth(word) <= ARG_WIDTH) return word;
    if (!word.includes("/") || word.includes("://")) return clip(word, ARG_WIDTH);
    const chars = [...word];
    let tail = "";
    while (chars.length && visibleWidth(tail) + visibleWidth(chars.at(-1)!) < ARG_WIDTH)
        tail = chars.pop() + tail;
    const slash = tail.indexOf("/");
    return `…${slash > 0 && slash < tail.length / 2 ? tail.slice(slash) : tail}`;
}
// A pipeline reads as one command. Navigation and bare echo labels only frame the real
// commands, so they should not take a visible slot from them.
function shellUnits(command: string): ShellPart[][] {
    const units: ShellPart[][] = [];
    for (const part of shellParts(command)) {
        if (part.piped && units.length) units.at(-1)!.push(part);
        else units.push([part]);
    }
    return units;
}
function isNoise(unit: ShellPart[]): boolean {
    const tokens = unit.length === 1 ? unit[0]!.tokens : [];
    return (
        tokens[0] === "cd" || (tokens[0] === "echo" && !tokens.some((word) => /^\d*>/.test(word)))
    );
}
function summarizeCommand(tokens: string[], depth: number): string {
    const words = tokens.filter((word, index) => index > 0 || !/^[\w]+=.*/.test(word));
    while (words.length && /^[\w]+=.*/.test(words[0]!)) words.shift();
    const executable = words.shift() ?? "";
    const program = executable.split(/[\\/]/).at(-1)!;
    if (
        /^(?:bash|sh|zsh|fish|pwsh|powershell)$/.test(program) &&
        words.some((word) => /^-(?:[a-z]*c|Command)$/.test(word))
    ) {
        const option = words.findIndex((word) => /^-(?:[a-z]*c|Command)$/.test(word));
        return depth < 2
            ? summarizeShell(words[option + 1] ?? "", depth + 1)
            : `${program} · inline script`;
    }
    if (/^(?:node|python[\d.]*|ruby|perl)$/.test(program)) {
        if (words.some((word) => ["-e", "-c", "--eval"].includes(word)))
            return `${program} · inline script`;
        const file = words.find((word) => !word.startsWith("-"));
        return [program, words.includes("--test") ? "--test" : "", file ?? ""]
            .filter(Boolean)
            .join(" ");
    }
    if (/^(?:npm|pnpm|yarn|bun)$/.test(program)) {
        const args = words.filter((word) => !word.startsWith("-"));
        return [program, ...args.slice(0, args[0] === "run" ? 2 : 1)].join(" ");
    }
    const args = words.slice(0, 3).map((word) => fitArg(singleLine(word)));
    return [
        program,
        ...args,
        words.length > 3 ? `+${words.length - 3} ${words.length === 4 ? "arg" : "args"}` : "",
    ]
        .filter(Boolean)
        .join(" ");
}
const SUMMARY_WIDTH = 80;
const hiddenCount = (hidden: number) =>
    hidden > 0 ? ` · +${hidden} ${hidden === 1 ? "command" : "commands"}` : "";
const MAX_CACHED_SUMMARIES = 64;
const cachedSummaries = new Map<string, string>();
// Cards re-summarize their command on every frame, and a command can be a script tens of KB long.
export function commandSummary(command: string, depth = 0): string {
    if (depth) return summarizeShell(command, depth);
    let summary = cachedSummaries.get(command);
    if (summary === undefined) {
        if (cachedSummaries.size >= MAX_CACHED_SUMMARIES) cachedSummaries.clear();
        summary = summarizeShell(command, depth);
        cachedSummaries.set(command, summary);
    }
    return summary;
}
function summarizeShell(command: string, depth: number): string {
    const all = shellUnits(command);
    const units = all.filter((unit) => !isNoise(unit));
    if (!units.length) units.push(...all);
    const texts = units
        .map((unit) => unit.map((part) => summarizeCommand(part.tokens, depth)).join(" | "))
        .filter(Boolean);
    // Show whole commands while they fit; the hidden-command count is never clipped.
    for (let count = Math.min(2, texts.length); count > 1; count--) {
        const text = texts.slice(0, count).join(" · ");
        const suffix = hiddenCount(texts.length - count);
        if (visibleWidth(text) + suffix.length <= SUMMARY_WIDTH) return singleLine(text + suffix);
    }
    const suffix = hiddenCount(texts.length - 1);
    return singleLine(clip(texts[0] ?? "", SUMMARY_WIDTH - suffix.length) + suffix);
}

export function toolSummary(name: string, args: Record<string, unknown>, cwd?: string): string {
    if (name === "codemode") return "";
    if (typeof args.command === "string") return commandSummary(args.command);
    const path = singleLine(args.path ?? args.file_path);
    if (path) {
        const api = posix.isAbsolute(path) ? posix : win32.isAbsolute(path) ? win32 : undefined;
        const relative = api && cwd && api.isAbsolute(cwd) ? api.relative(cwd, path) : path;
        const display =
            relative && relative !== ".." && !relative.startsWith(`..${api?.sep}`)
                ? relative
                : path;
        const pattern = singleLine(args.pattern);
        return pattern ? `${pattern} · ${display}` : display;
    }
    for (const key of ["command", "query", "url", "name", "description", "question", "prompt"]) {
        const value = singleLine(args[key]);
        if (value) return value;
    }
    const script = singleLine(args.code ?? args.script);
    if (script) return script;
    for (const [key, value] of Object.entries(args)) {
        if (Array.isArray(value)) return `${key}: ${value.length} items`;
        if (typeof value === "string" && value) return singleLine(value);
    }
    return "";
}
/** The file URL for a summary that shows only a path; a search pattern keeps the summary unlinked. */
export function toolHref(
    name: string,
    args: Record<string, unknown>,
    cwd?: string,
): string | undefined {
    if (name === "codemode" || typeof args.command === "string" || singleLine(args.pattern))
        return undefined;
    const path = singleLine(args.path ?? args.file_path);
    return path && cwd && hyperlinksEnabled() ? fileHref(path, cwd) : undefined;
}
export function fitSummary(value: string, width: number, limit: number): string {
    return clip(value, Math.max(0, limit > 0 ? Math.min(width, limit) : width));
}
