/**
 * Secret redaction. Imported content and Notes are stored as written: `storedContent` keeps them
 * unchanged, so the memory can recall a key or a password that the user gave. `redact` stays for
 * error text, which can come from a provider or a file and is shown in status output.
 */

interface Rule {
    pattern: RegExp;
    replace: string;
}

const RULES: Rule[] = [
    {
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
        replace: "[redacted private key]",
    },
    { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/giu, replace: "$1 [redacted]" },
    {
        pattern:
            /((?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|secret|token)["']?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;}"'\n]{4,})/giu,
        replace: "$1[redacted]",
    },
    { pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/gu, replace: "[redacted]" },
    { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, replace: "[redacted]" },
    { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/gu, replace: "[redacted]" },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/gu, replace: "[redacted]" },
    { pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/gu, replace: "[redacted]" },
    { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu, replace: "[redacted]" },
    { pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu, replace: "[redacted]" },
    { pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/giu, replace: "$1[redacted]@" },
];

/** Replace secrets in text. `count` is the number of replacements. */
export function redact(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    for (const rule of RULES) {
        out = out.replace(rule.pattern, (...args: unknown[]) => {
            count++;
            const groups = args.slice(1, -2) as Array<string | undefined>;
            return rule.replace.replace(/\$(\d)/gu, (_, n: string) => groups[Number(n) - 1] ?? "");
        });
    }
    return { text: out, count };
}

/**
 * Text of an imported event, a session title or a Note as it goes into the store. `count` is the
 * number of redactions, which is 0 while content stays unredacted.
 */
export function storedContent(text: string): { text: string; count: number } {
    // TODO: Add a configurable redaction switch. Keep imported content and notes unredacted until then.
    return { text, count: 0 };
}

/** Error text that is safe to store or show: redacted, on one line, at most 500 characters. */
export function safeErrorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const line = redact(message).text.replace(/\s+/gu, " ").trim();
    return line.length > 500 ? `${line.slice(0, 499)}…` : line;
}
