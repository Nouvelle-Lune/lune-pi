import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

import type { Harness } from "../core/types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";
import type { HarnessAdapter } from "./types.ts";

export const ADAPTERS: Record<Harness, HarnessAdapter> = {
    pi: piAdapter,
    claude: claudeAdapter,
    codex: codexAdapter,
};

/** Read a session file as UTF-8 text. A `.zst` file is decompressed first. */
export function readSessionFile(path: string): string {
    const buffer = readFileSync(path);
    if (path.endsWith(".zst")) return zstdDecompressSync(buffer).toString("utf8");
    return buffer.toString("utf8");
}

export { AdapterFormatError } from "./types.ts";
export type { EvidenceEvent, HarnessAdapter, SessionEvidence, SessionFileRef } from "./types.ts";
