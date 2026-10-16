import { createHash } from "node:crypto";

import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const MAX_COMPACTION_SUMMARY_CHARS = 4000;
const MAX_RECENT_ITEM_CHARS = 2000;
const MAX_RECENT_ITEMS = 8;

export type RecapItemRole = "summary" | "user" | "assistant" | "context" | "tool";

export interface RecapItem {
    role: RecapItemRole;
    text: string;
}

export interface RecapInput {
    /**
     * Latest compaction summary in Pi's active projection.
     *
     * This is kept separately because it represents the long-term context that
     * Pi intentionally retained after dropping older conversation history.
     */
    anchor?: string;

    /**
     * Model-visible activity after projection.
     *
     * Entries remain in chronological order. Large message bodies, thinking
     * blocks, images, and tool result bodies are intentionally excluded.
     */
    recent: RecapItem[];

    hasContent: boolean;
}

/**
 * Normalize text before it becomes part of a single-line recap request or hint.
 *
 * Terminal escapes and control characters are removed because session content
 * is untrusted and may otherwise affect terminal rendering.
 */
export function cleanText(text: string): string {
    return stripTerminalSequences(text)
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

/**
 * Truncate by Unicode code point rather than UTF-16 code unit.
 */
export function limitText(text: string, limit: number): string {
    return Array.from(cleanText(text)).slice(0, limit).join("");
}

function addTextItem(items: RecapItem[], role: RecapItemRole, text: string): void {
    const cleaned = cleanText(text);

    if (cleaned) {
        items.push({ role, text: cleaned });
    }
}

/**
 * Collect recap input from Pi's active session projection.
 *
 * Session semantics remain owned by Pi. This function does not reconstruct
 * compaction history, replay context edits, or recover messages that Pi has
 * intentionally removed from the active projection.
 */
export function collectRecapInput(ctx: ExtensionContext): RecapInput {
    const projection = ctx.sessionManager.buildSessionProjection();

    let anchor: string | undefined;
    const recent: RecapItem[] = [];

    for (const message of projection.messages) {
        switch (message.role) {
            case "compactionSummary": {
                const summary = cleanText(message.summary);

                if (summary) {
                    // A projected compaction summary is the authoritative
                    // long-term context anchor for the active conversation.
                    anchor = summary;
                }

                break;
            }

            case "branchSummary":
                addTextItem(recent, "summary", message.summary);
                break;

            case "user":
                addTextItem(recent, "user", contentText(message.content));
                break;

            case "assistant":
                // contentText() deliberately excludes thinking and tool calls.
                addTextItem(recent, "assistant", contentText(message.content));
                break;

            case "custom":
                // Custom messages participate in Pi's model context, so retain
                // their visible text without extension-specific metadata.
                addTextItem(recent, "context", contentText(message.content));
                break;

            case "toolResult":
                // Tool bodies can be very large and frequently contain
                // untrusted output. The outcome is sufficient for recap.
                addTextItem(
                    recent,
                    "tool",
                    `${message.toolName}: ${message.isError ? "failed" : "succeeded"}`,
                );
                break;

            case "bashExecution": {
                if (message.excludeFromContext) {
                    break;
                }

                const status = message.cancelled
                    ? "cancelled"
                    : message.exitCode === undefined || message.exitCode === 0
                      ? "succeeded"
                      : `failed with exit code ${message.exitCode}`;

                addTextItem(recent, "tool", `shell ${status}: ${message.command}`);
                break;
            }

            case "system":
                // System prompt state is not part of a user-facing session recap.
                break;
        }
    }

    return {
        anchor,
        recent,
        hasContent: Boolean(anchor || recent.length > 0),
    };
}

/**
 * Select a bounded recent window while always retaining the latest user and
 * assistant messages when they exist.
 */
function selectRecentItems(items: RecapItem[]): RecapItem[] {
    const selected = new Set<number>();

    const lastUser = items.findLastIndex((item) => item.role === "user");
    const lastAssistant = items.findLastIndex((item) => item.role === "assistant");

    if (lastUser >= 0) {
        selected.add(lastUser);
    }

    if (lastAssistant >= 0) {
        selected.add(lastAssistant);
    }

    for (let index = items.length - 1; index >= 0 && selected.size < MAX_RECENT_ITEMS; index--) {
        selected.add(index);
    }

    return [...selected]
        .sort((a, b) => a - b)
        .map((index): RecapItem => {
            // Every index in the set originates from this array's valid range.
            const item = items[index]!;

            return {
                ...item,
                text: limitText(item.text, MAX_RECENT_ITEM_CHARS),
            };
        });
}

/**
 * Serialize exactly the bounded data supplied to the recap model.
 */
export function serializeRecapInput(input: RecapInput): string {
    return JSON.stringify({
        anchor: input.anchor ? limitText(input.anchor, MAX_COMPACTION_SUMMARY_CHARS) : undefined,
        recent: selectRecentItems(input.recent),
    });
}

/**
 * Fingerprint the exact model input rather than a parallel representation.
 */
export function fingerprintRecapInput(input: RecapInput): string {
    return createHash("sha256").update(serializeRecapInput(input)).digest("hex");
}
