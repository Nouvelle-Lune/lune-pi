export const MAX_HL_CHARS = 32000;
const MAX_CACHE_ENTRIES = 48;
type CodeToAnsi = (code: string, lang: string, theme: string) => Promise<string>;
type Loader = () => Promise<CodeToAnsi>;
type Subscriber = {
    fallback: readonly string[];
    invalidate: () => void;
};
type Pending = {
    work: Promise<void>;
    subscribers: Set<Subscriber>;
};
let defaultLoad: Promise<CodeToAnsi> | undefined;
const loadDefault: Loader = () => {
    if (!defaultLoad) {
        defaultLoad = import("@shikijs/cli")
            .then((module) => module.codeToANSI as CodeToAnsi)
            .catch((error) => {
                defaultLoad = undefined;
                throw error;
            });
    }
    return defaultLoad;
};
function differs(lines: readonly string[], fallback: readonly string[]): boolean {
    return (
        lines.length !== fallback.length || lines.some((line, index) => line !== fallback[index])
    );
}
export class ShikiHighlightCache {
    private readonly cache = new Map<string, string[]>();
    private readonly pending = new Map<string, Pending>();
    private readonly loader: Loader;
    private generation = 0;
    constructor(loader: Loader = loadDefault) {
        this.loader = loader;
    }
    get(
        code: string,
        lang: string | undefined,
        theme: string,
        fallback: readonly string[],
        invalidate?: () => void,
    ): string[] | undefined {
        if (!lang || code.length > MAX_HL_CHARS) return undefined;
        const key = `${theme}\0${lang}\0${code}`;
        const cached = this.cache.get(key);
        if (cached) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        const existing = this.pending.get(key);
        if (existing) {
            if (
                invalidate &&
                ![...existing.subscribers].some((item) => item.invalidate === invalidate)
            ) {
                existing.subscribers.add({ fallback, invalidate });
            }
            return undefined;
        }
        if (this.pending.size >= 12) return undefined;
        const generation = this.generation;
        const pending: Pending = { work: undefined as never, subscribers: new Set() };
        if (invalidate) pending.subscribers.add({ fallback, invalidate });
        pending.work = this.loader()
            .then((highlight) => highlight(code, lang, theme))
            .then((ansi) => {
                if (generation !== this.generation) return;
                const lines = ansi.replace(/\r/g, "").replace(/\n$/, "").split("\n");
                this.cache.set(key, lines);
                while (this.cache.size > MAX_CACHE_ENTRIES) {
                    const oldest = this.cache.keys().next().value;
                    if (oldest !== undefined) this.cache.delete(oldest);
                }
                for (const subscriber of pending.subscribers) {
                    if (!differs(lines, subscriber.fallback)) continue;
                    try {
                        subscriber.invalidate();
                    } catch {}
                }
            })
            .catch(() => {})
            .finally(() => {
                if (this.pending.get(key) === pending) this.pending.delete(key);
            });
        this.pending.set(key, pending);
        return undefined;
    }
    clear(): void {
        this.generation++;
        this.cache.clear();
        for (const pending of this.pending.values()) pending.subscribers.clear();
        this.pending.clear();
    }
}
export const shikiHighlightCache = new ShikiHighlightCache();
