export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as JsonObject;
}

/** Parse one record at a time so large tool payloads are not all retained with the messages. */
export function* jsonl(content: string, path: string): Generator<JsonObject> {
    let start = 0;
    let line = 0;
    while (start < content.length) {
        const end = content.indexOf("\n", start);
        const text = content.slice(start, end === -1 ? content.length : end);
        start = end === -1 ? content.length : end + 1;
        line++;
        if (!text.trim()) continue;
        try {
            yield object(JSON.parse(text));
        } catch (error) {
            throw new Error(`Invalid JSONL at ${path}:${line}`, { cause: error });
        }
    }
}

export function string(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`Expected a string for ${field}`);
    return value;
}

export function sessionId(value: unknown, field: string): string {
    const id = string(value, field);
    // Ids become mention tokens and temporary filenames, so path separators are never valid.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
        throw new Error(`Invalid session id for ${field}`);
    }
    return id;
}

export function date(value: unknown, field: string): Date {
    const parsed = new Date(string(value, field));
    if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid date for ${field}`);
    return parsed;
}

/** Only text blocks belong in the reference; images, thinking and tool payloads stay in JSONL. */
export function textContent(value: unknown, types: readonly string[]): string {
    if (!Array.isArray(value)) throw new Error("Expected an array of content blocks");
    return value
        .map((part: unknown) => object(part))
        .filter((part) => types.includes(string(part.type, "content.type")))
        .map((part) => string(part.text, "content.text"))
        .join("\n");
}
