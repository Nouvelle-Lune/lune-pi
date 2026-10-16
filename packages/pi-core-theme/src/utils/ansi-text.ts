const CSI_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const OSC_SEQUENCE_STRICT_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(line: string): string {
    return line.replace(CSI_SEQUENCE_RE, "");
}
export function stripTerminalSequencesPreservingLayout(value: string): string {
    return value.replace(OSC_SEQUENCE_RE, "").replace(CSI_SEQUENCE_RE, "");
}
export function stripTerminalSequences(value: string): string {
    return stripTerminalSequencesPreservingLayout(value).replace(/\s+/g, " ").trim();
}
export function hasVisibleText(line: string): boolean {
    return line.replace(CSI_SEQUENCE_RE, "").replace(OSC_SEQUENCE_STRICT_RE, "").trim().length > 0;
}
export function stripBackgroundAnsi(line: string): string {
    return line.replace(/\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]+)+|49)m/g, "");
}
export function stripLeadingStatusIcon(line: string): string {
    return line.replace(
        /^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[✓✗●○■⬤•·])(?:\x1b\[[0-9;]*m)*\s+/,
        "$1",
    );
}
const ANY_SEQUENCE_RE = new RegExp(`${CSI_SEQUENCE_RE.source}|${OSC_SEQUENCE_RE.source}`, "g");
function keepOutsideRange(text: string, base: number, start: number, end: number): string {
    if (base + text.length <= start || base >= end) return text;
    return text.slice(0, Math.max(0, start - base)) + text.slice(Math.max(0, end - base));
}
export function removeStyledRange(styled: string, start: number, end: number): string {
    if (end <= start) return styled;
    let plain = 0;
    let cursor = 0;
    let out = "";
    for (const match of styled.matchAll(ANY_SEQUENCE_RE)) {
        const text = styled.slice(cursor, match.index);
        out += keepOutsideRange(text, plain, start, end);
        plain += text.length;
        out += match[0];
        cursor = match.index + match[0].length;
    }
    return out + keepOutsideRange(styled.slice(cursor), plain, start, end);
}
