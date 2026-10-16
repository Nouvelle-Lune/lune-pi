export function formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens);
    if (tokens < 100000) return `${(tokens / 1000).toFixed(1)}k`;
    return `${Math.round(tokens / 1000)}k`;
}
