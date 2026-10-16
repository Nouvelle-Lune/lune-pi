import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import {
    getAgentDir,
    getLastAssistantUsage,
    SettingsManager,
    type ExtensionContext,
    type ReadonlyFooterDataProvider,
    type SessionEntry,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Nerd Font glyphs, written as escapes so the source stays free of invisible private-use characters. */
const FOLDER_ICON = "";
const BRANCH_ICON = "";

export const CELL_SEPARATOR = " │ ";
const SEPARATOR_WIDTH = visibleWidth(CELL_SEPARATOR);

/**
 * Every statistic owns a slot whose width is fixed up front. Values change on every turn, and a
 * slot that tracked its text would shift every neighbour with it, so each value is padded to the
 * widest text it can take instead.
 */
const COUNT_WIDTH = 4; // "999", "9.9k", "999k", "9.9M"
const PERCENT_WIDTH = 5; // "9.9%", "99.9%", "100%"
const COST_WIDTH = 7; // "$99.999"

export interface DockUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** Share of the latest prompt served from cache, in percent. */
    cacheHitRate: number | undefined;
}

/** Everything the info rows display, so rendering never touches Pi. */
export interface DockStatus {
    cwd: string;
    branch: string | null;
    sessionName: string | undefined;
    model: { provider: string; id: string; thinking: string | undefined } | undefined;
    /** Pi names the provider only when more than one is available. */
    showProvider: boolean;
    usage: DockUsage;
    /** Pi reports no tokens or share until the first response after a compaction. */
    context: { tokens: number | null; percent: number | null; window: number };
    autoCompact: boolean;
    extensionStatuses: readonly string[];
}

/**
 * Pi keeps its formatter private; this matches the rounding of its own footer. The extra `G` tier
 * keeps every result within four columns, which is all a counter slot reserves.
 */
function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    const units = ["k", "M", "G"];
    let scaled = count / 1000;
    for (let unit = 0; ; unit++) {
        const text = scaled < 9.95 ? scaled.toFixed(1) : String(Math.round(scaled));
        // Rounding can carry into the next unit (999.6k), which must read 1.0M, not 1000k.
        if (Number(text) < 1000 || unit === units.length - 1) return text + units[unit];
        scaled /= 1000;
    }
}

/** Whole percent once the decimal would no longer fit, so 100% costs no extra column. */
function formatPercent(percent: number): string {
    return percent >= 99.95 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

/** Spends fewer decimals as the amount grows so the text never outgrows its slot. */
function formatCost(cost: number): string {
    for (const decimals of [3, 2, 1, 0]) {
        const text = `$${cost.toFixed(decimals)}`;
        if (text.length <= COST_WIDTH) return text;
    }
    return `$${Math.round(cost)}`;
}

function abbreviateHome(cwd: string): string {
    const fromHome = relative(homedir(), cwd);
    if (fromHome === "") return "~";
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return cwd;
    return `~${sep}${fromHome}`;
}

interface UsageLike {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
}

/** Totals span every session entry, not just the current branch, as Pi's footer does. */
function summarizeUsage(entries: SessionEntry[]): DockUsage {
    const usage: DockUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        cacheHitRate: undefined,
    };
    const add = (part: UsageLike): void => {
        usage.input += part.input;
        usage.output += part.output;
        usage.cacheRead += part.cacheRead;
        usage.cacheWrite += part.cacheWrite;
        usage.cost += part.cost.total;
    };
    for (const entry of entries) {
        if (entry.type === "usage") {
            add(entry.usage);
        } else if (entry.type === "message") {
            if (entry.message.role === "assistant") add(entry.message.usage);
            else if (entry.message.role === "toolResult" && entry.message.usage) {
                add(entry.message.usage);
            }
        } else if (
            (entry.type === "branch_summary" || entry.type === "compaction") &&
            entry.usage
        ) {
            add(entry.usage);
        }
    }
    const latest = getLastAssistantUsage(entries);
    if (latest) {
        const prompt = latest.input + latest.cacheRead + latest.cacheWrite;
        usage.cacheHitRate = prompt > 0 ? (latest.cacheRead / prompt) * 100 : undefined;
    }
    return usage;
}

function readAutoCompact(ctx: ExtensionContext): boolean {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionEnabled();
}

/** Reads the statistics Pi publishes to extensions; the dock replaces Pi's footer, so it must show them. */
export class DockStatusSource {
    private usage: { key: string; value: DockUsage } | undefined;
    private autoCompact: { ctx: ExtensionContext; value: boolean } | undefined;
    private readonly readAutoCompact: (ctx: ExtensionContext) => boolean;

    constructor(readCompaction: (ctx: ExtensionContext) => boolean = readAutoCompact) {
        this.readAutoCompact = readCompaction;
    }

    collect(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): DockStatus {
        const model = ctx.model;
        const level = ctx.thinkingLevel ?? "off";
        const contextUsage = ctx.getContextUsage();
        const statuses = [...footerData.getExtensionStatuses()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) =>
                text
                    .replace(/[\r\n\t]/g, " ")
                    .replace(/ +/g, " ")
                    .trim(),
            )
            .filter((text) => text.length > 0);
        return {
            cwd: abbreviateHome(ctx.sessionManager.getCwd()),
            branch: footerData.getGitBranch(),
            sessionName: ctx.sessionManager.getSessionName(),
            model: model && {
                provider: model.provider,
                id: model.id,
                thinking: model.reasoning ? (level === "off" ? "thinking off" : level) : undefined,
            },
            showProvider: footerData.getAvailableProviderCount() > 1,
            usage: this.collectUsage(ctx),
            context: {
                tokens: contextUsage?.tokens ?? null,
                percent: contextUsage?.percent ?? null,
                window: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
            },
            autoCompact: this.collectAutoCompact(ctx),
            extensionStatuses: statuses,
        };
    }

    /** The scan is linear in the session and runs every frame; entries are append-only and each append moves the leaf. */
    private collectUsage(ctx: ExtensionContext): DockUsage {
        const entries = ctx.sessionManager.getEntries();
        const key = `${ctx.sessionManager.getSessionId()}\0${ctx.sessionManager.getLeafId()}\0${entries.length}`;
        if (this.usage?.key !== key) this.usage = { key, value: summarizeUsage(entries) };
        return this.usage.value;
    }

    /** Settings files are read once per session context, not per frame. */
    private collectAutoCompact(ctx: ExtensionContext): boolean {
        if (this.autoCompact?.ctx !== ctx) {
            this.autoCompact = { ctx, value: this.readAutoCompact(ctx) };
        }
        return this.autoCompact.value;
    }
}

/** The provider is the first thing to go when the model name has to fit a narrow budget. */
export function renderModelSegment(status: DockStatus, theme: Theme, width: number): string {
    const model = status.model;
    const name = model?.id ?? "no-model";
    const thinking = model?.thinking ? theme.fg("dim", ` • ${model.thinking}`) : "";
    const bare = name + thinking;
    const withProvider =
        status.showProvider && model ? theme.fg("accent", `(${model.provider}) `) + bare : bare;
    return visibleWidth(withProvider) <= width ? withProvider : truncateToWidth(bare, width);
}

/** Right-aligned, so a growing number extends leftwards into its own padding and nothing else moves. */
function field(text: string, width: number): string {
    const gap = width - visibleWidth(text);
    return gap >= 0 ? " ".repeat(gap) + text : truncateToWidth(text, width);
}

function value(theme: Theme, text: string, width: number): string {
    return field(theme.fg("muted", text), width);
}

const CONTEXT_JOINER = " · ";
const CONTEXT_WIDTH = COUNT_WIDTH + 1 + COUNT_WIDTH + visibleWidth(CONTEXT_JOINER) + PERCENT_WIDTH;

/**
 * Tokens in use over the window, then the share. Turns warning/error at the same thresholds as Pi's
 * own footer. The window is constant for a model, so only the used count and share need room to grow.
 */
export function renderContextCell(status: DockStatus, theme: Theme): string {
    const { tokens, percent, window } = status.context;
    const used = field(tokens === null ? "?" : formatTokens(tokens), COUNT_WIDTH);
    const share = field(percent === null ? "?" : formatPercent(percent), PERCENT_WIDTH);
    return theme.fg(
        (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "muted",
        field(`${used}/${formatTokens(window)}${CONTEXT_JOINER}${share}`, CONTEXT_WIDTH),
    );
}

interface StatSlot {
    /** Higher survives longer when the row is too narrow. */
    keep: number;
    /** Columns reserved for the slot with every part present, whatever the values are. */
    width: number;
    /** Nothing is drawn for a slot without data, and `render` leaves out any part that has none. */
    hasData(status: DockStatus): boolean;
    render(status: DockStatus, theme: Theme): string;
}

/** A counter that is still zero is left out, so a provider that never reports it shows no gap. */
function counters(theme: Theme, ...parts: [label: string, count: number][]): string {
    return parts
        .filter(([, count]) => count > 0)
        .map(
            ([label, count]) =>
                theme.fg("muted", label) + value(theme, formatTokens(count), COUNT_WIDTH),
        )
        .join(" ");
}

/**
 * Which slots exist depends on the session, never on the numbers: auto-compaction is a setting
 * read once per session, so (auto) only claims its columns when it will be shown. Whether a slot
 * is drawn is a separate question, answered by `hasData`.
 */
function statSlots(status: DockStatus): StatSlot[] {
    const counterWidth = 2 * (1 + COUNT_WIDTH) + 1;
    const slots: StatSlot[] = [
        {
            keep: 3,
            width: counterWidth,
            hasData: ({ usage }) => usage.input > 0 || usage.output > 0,
            render: ({ usage }, theme) => counters(theme, ["↑", usage.input], ["↓", usage.output]),
        },
        {
            keep: 1,
            width: counterWidth,
            hasData: ({ usage }) => usage.cacheRead > 0 || usage.cacheWrite > 0,
            render: ({ usage }, theme) =>
                counters(theme, ["R", usage.cacheRead], ["W", usage.cacheWrite]),
        },
        {
            keep: 2,
            width: 2 + PERCENT_WIDTH,
            // A provider that reports no cache traffic has no hit rate worth quoting.
            hasData: ({ usage }) =>
                (usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined,
            render: ({ usage }, theme) =>
                theme.fg("muted", "CH") +
                value(theme, formatPercent(usage.cacheHitRate ?? 0), PERCENT_WIDTH),
        },
        {
            keep: 4,
            width: COST_WIDTH,
            hasData: ({ usage }) => usage.cost > 0,
            render: ({ usage }, theme) => value(theme, formatCost(usage.cost), COST_WIDTH),
        },
        {
            keep: 6,
            width: CONTEXT_WIDTH,
            hasData: () => true,
            render: (current, theme) => renderContextCell(current, theme),
        },
    ];
    if (status.autoCompact) {
        slots.push({
            keep: 5,
            width: 6,
            hasData: () => true,
            render: (_current, theme) => theme.fg("accent", "(auto)"),
        });
    }
    return slots;
}

function slotsWidth(slots: readonly StatSlot[]): number {
    return slots.reduce((sum, slot) => sum + slot.width, 0) + SEPARATOR_WIDTH * (slots.length - 1);
}

/**
 * Drops the least important slots until the rest fit. Only the reserved widths are compared, so
 * the same terminal width always yields the same slots, whatever the numbers currently say.
 */
function fitSlots(slots: StatSlot[], budget: number): StatSlot[] {
    const kept = [...slots];
    while (kept.length > 1 && slotsWidth(kept) > budget) {
        const weakest = kept.reduce((low, slot) => (slot.keep < low.keep ? slot : low));
        kept.splice(kept.indexOf(weakest), 1);
    }
    return kept;
}

/** Keeps the trailing segments, which name the project, and elides the leading ones. */
function shortenPath(path: string, width: number): string {
    if (visibleWidth(path) <= width) return path;
    const segments = path.split(sep);
    for (let count = segments.length - 1; count >= 1; count--) {
        const candidate = `…${sep}${segments.slice(-count).join(sep)}`;
        if (visibleWidth(candidate) <= width) return candidate;
    }
    return truncateToWidth(segments.at(-1) ?? path, Math.max(0, width));
}

export interface InfoRowParts {
    workspace: boolean;
    usage: boolean;
}

/**
 * Room kept for the directory and branch before any statistic is placed. A fixed share, not the
 * current path, so a branch switch cannot make a counter appear or vanish.
 */
const MIN_WORKSPACE_WIDTH = 40;

/**
 * Working directory and branch on the left, usage statistics right-aligned in reserved slots.
 * The slots reserved follow from the terminal width alone, and a slot with no data yet is simply
 * not drawn. Changing numbers only ever rewrite the padding inside their own slot.
 */
export function renderInfoRow(
    status: DockStatus,
    width: number,
    theme: Theme,
    parts: InfoRowParts = { workspace: true, usage: true },
): string {
    const branch = status.branch ? `  ${BRANCH_ICON} (${status.branch})` : "";
    const session = status.sessionName ? ` • ${status.sessionName}` : "";
    const fixedWidth = visibleWidth(` ${FOLDER_ICON}  ${branch}${session}`);

    const bar = parts.workspace ? theme.fg("dim", CELL_SEPARATOR) : "";
    const budget = width - (parts.workspace ? MIN_WORKSPACE_WIDTH + visibleWidth(bar) : 0);
    const reserved = parts.usage ? fitSlots(statSlots(status), budget) : [];
    const slots = reserved.filter((slot) => slot.hasData(status));
    // The right block is right-aligned, so a slot gaining data never moves the slots to its right;
    // the directory is shortened against the full reservation so it does not move either.
    const reservedWidth = reserved.length > 0 ? visibleWidth(bar) + slotsWidth(reserved) : 0;
    const right =
        slots.length > 0
            ? truncateToWidth(
                  bar +
                      slots
                          .map((slot) => slot.render(status, theme))
                          .join(theme.fg("dim", CELL_SEPARATOR)),
                  width,
              )
            : "";

    let left = "";
    if (parts.workspace) {
        const cwd = shortenPath(status.cwd, width - reservedWidth - fixedWidth);
        left =
            ` ${theme.fg("muted", `${FOLDER_ICON}  ${cwd}`)}` +
            (branch && theme.fg("accent", branch)) +
            theme.fg("dim", session);
    }
    const clipped = truncateToWidth(
        left,
        Math.max(0, width - visibleWidth(right)),
        theme.fg("dim", "…"),
    );
    return (
        clipped +
        " ".repeat(Math.max(0, width - visibleWidth(clipped) - visibleWidth(right))) +
        right
    );
}

/** Statuses set through `ctx.ui.setStatus()` lived in Pi's footer, so the dock keeps showing them. */
export function renderStatusRow(
    statuses: readonly string[],
    width: number,
    theme: Theme,
): string | undefined {
    if (statuses.length === 0) return undefined;
    return truncateToWidth(` ${statuses.join(" ")}`, width, theme.fg("dim", "…"));
}
