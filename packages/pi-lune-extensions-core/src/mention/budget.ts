/**
 * The default size of the session index. Kept free of runtime imports, because Core's settings
 * declare it as their default and the settings screen loads them.
 */
export const INDEX_BUDGET_MB = 4;
export const SESSION_TEXT_LIMIT = 8_000;

/** Megabytes (MiB) to bytes. */
export function megabytes(size: number): number {
    return size * 1024 * 1024;
}
