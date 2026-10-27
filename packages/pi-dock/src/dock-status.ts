import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import {
    getAgentDir,
    getLastAssistantUsage,
    SettingsManager,
    type ExtensionContext,
    type MessageEndEvent,
    type MessageStartEvent,
    type MessageUpdateEvent,
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

export interface DockTokenSpeed {
    tokensPerSecond: number | undefined;
    generating: boolean;
}

export type DockMessageEvent = MessageStartEvent | MessageUpdateEvent | MessageEndEvent;

/** Everything the info rows display, so rendering never touches Pi. */
export interface DockStatus {
    cwd: string;
    branch: string | null;
    sessionName: string | undefined;
    model: { provider: string; id: string; thinking: string | undefined } | undefined;
    /** Pi names the provider only when more than one is available. */
    showProvider: boolean;
    tokenSpeed: DockTokenSpeed;
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
    private response:
        | {
              ui: ExtensionContext["ui"];
              sessionId: string;
              requestTimestamp: number;
              provider: string | undefined;
              model: string | undefined;
              speed: DockTokenSpeed;
          }
        | undefined;

    observeMessage(event: DockMessageEvent, ctx: ExtensionContext): boolean {
        const message = event.message;
        if (message.role !== "assistant") return false;
        const sessionId = ctx.sessionManager.getSessionId();
        const previous = this.response;
        const continuing =
            event.type !== "message_start" &&
            previous?.ui === ctx.ui &&
            previous.sessionId === sessionId &&
            previous.requestTimestamp === message.timestamp;
        const generating = event.type !== "message_end";
        const { output } = message.usage;
        const duration = message.durationMs;
        // Partial usage is not a provider-neutral live token counter; only final SDK timing is measured.
        const rate =
            !generating &&
            Number.isFinite(output) &&
            output > 0 &&
            duration !== undefined &&
            Number.isFinite(duration) &&
            duration > 0
                ? (output / duration) * 1000
                : undefined;
        this.response = {
            ui: ctx.ui,
            sessionId,
            requestTimestamp: message.timestamp,
            // Virtual selections route to physical message models; keep the selection that began this response.
            provider: continuing ? previous.provider : ctx.model?.provider,
            model: continuing ? previous.model : ctx.model?.id,
            speed: {
                tokensPerSecond:
                    rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : undefined,
                generating,
            },
        };
        return true;
    }

    resetTokenSpeed(): void {
        this.response = undefined;
    }

    private collectTokenSpeed(ctx: ExtensionContext): DockTokenSpeed {
        const response = this.response;
        const model = ctx.model;
        return model &&
            response?.ui === ctx.ui &&
            response.sessionId === ctx.sessionManager.getSessionId() &&
            response.provider === model.provider &&
            response.model === model.id
            ? response.speed
            : { tokensPerSecond: undefined, generating: false };
    }

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
            tokenSpeed: this.collectTokenSpeed(ctx),
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

const SPEED_VALUE_WIDTH = 6;

function formatTokenSpeed(rate: number | undefined): string {
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return "—";
    if (rate < 0.1) return "<0.1";
    for (const decimals of [1, 0]) {
        const text = rate.toFixed(decimals);
        if (text.length <= SPEED_VALUE_WIDTH) return text;
    }
    return rate.toExponential(0);
}

/** Drop optional segments whole before spending any of the model's own columns. */
export function modelSegmentVariants(status: DockStatus, theme: Theme): string[] {
    const model = status.model;
    const name = model?.id ?? "no-model";
    const thinking = model?.thinking ? theme.fg("dim", ` • ${model.thinking}`) : "";
    const bare = name + thinking;
    const withProvider =
        status.showProvider && model ? theme.fg("accent", `(${model.provider}) `) + bare : bare;
    if (!model) return [bare];
    const speed = theme.fg(
        status.tokenSpeed.generating ? "accent" : "dim",
        ` · ${padStart(formatTokenSpeed(status.tokenSpeed.tokensPerSecond), SPEED_VALUE_WIDTH)} tok/s`,
    );
    return [...new Set([withProvider + speed, bare + speed, withProvider, bare])];
}

export function renderModelSegment(status: DockStatus, theme: Theme, width: number): string {
    const variants = modelSegmentVariants(status, theme);
    return (
        variants.find((text) => visibleWidth(text) <= width) ??
        truncateToWidth(variants.at(-1)!, width)
    );
}

/**
 * Left-aligned, so a label stays one column after its bar and a growing number spends only the
 * padding behind it.
 */
function padEnd(text: string, width: number): string {
    const gap = width - visibleWidth(text);
    return gap >= 0 ? text + " ".repeat(gap) : truncateToWidth(text, width);
}

/** Right-aligned, for the numerator of a fraction, so its slash never moves. */
function padStart(text: string, width: number): string {
    const gap = width - visibleWidth(text);
    return gap >= 0 ? " ".repeat(gap) + text : truncateToWidth(text, width);
}

const CONTEXT_JOINER = " · ";
const CONTEXT_WIDTH = COUNT_WIDTH + 1 + COUNT_WIDTH + visibleWidth(CONTEXT_JOINER) + PERCENT_WIDTH;

/**
 * Tokens in use over the window, then the share. Turns warning/error at the same thresholds as Pi's
 * own footer. The window is constant for a model, so only the used count and share need room to grow.
 */
export function renderContextCell(status: DockStatus, theme: Theme): string {
    const { tokens, percent, window } = status.context;
    const used = padStart(tokens === null ? "?" : formatTokens(tokens), COUNT_WIDTH);
    const share = percent === null ? "?" : formatPercent(percent);
    return theme.fg(
        (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "muted",
        padEnd(`${used}/${formatTokens(window)}${CONTEXT_JOINER}${share}`, CONTEXT_WIDTH),
    );
}

interface StatSlot {
    /** Higher survives longer when the row is too narrow. */
    keep: number;
    /** Columns reserved for the slot with every part present, whatever the values are. */
    width: number;
    /** A slot without data keeps its columns but draws neither its bar nor any text. */
    hasData(status: DockStatus): boolean;
    render(status: DockStatus, theme: Theme): string;
}

/**
 * Each counter keeps its own columns, so one that is still zero is blank rather than absent and the
 * counter after it never moves.
 */
function counters(theme: Theme, ...parts: [label: string, count: number][]): string {
    return parts
        .map(([label, count]) =>
            padEnd(
                count > 0 ? theme.fg("muted", label + formatTokens(count)) : "",
                1 + COUNT_WIDTH,
            ),
        )
        .join(" ");
}

/** A single counter with a slot to itself, drawn only once it is above zero. */
function counterSlot(keep: number, label: string, count: (usage: DockUsage) => number): StatSlot {
    return {
        keep,
        width: 1 + COUNT_WIDTH,
        hasData: ({ usage }) => count(usage) > 0,
        render: ({ usage }, theme) => theme.fg("muted", label + formatTokens(count(usage))),
    };
}

/**
 * Which slots exist depends on the session, never on the numbers: auto-compaction is a setting
 * read once per session, so (auto) only claims its columns when it will be shown. Whether a slot
 * is drawn is a separate question, answered by `hasData`.
 *
 * Slots run from the one most likely to stay empty to the ones always drawn, so blank slots gather
 * on the left, where they read as part of the gap after the directory, not as a hole between numbers.
 * `keep` orders the drop independently: the counters and cost give way first, while the hit rate
 * stays until only context and (auto) share the row.
 */
function statSlots(status: DockStatus): StatSlot[] {
    const slots: StatSlot[] = [
        // Cache writes come first: many providers never report them, and their slot then stays blank.
        counterSlot(1, "W", (usage) => usage.cacheWrite),
        counterSlot(2, "R", (usage) => usage.cacheRead),
        {
            keep: 5,
            width: 3 + PERCENT_WIDTH,
            // A provider that reports no cache traffic has no hit rate worth quoting.
            hasData: ({ usage }) =>
                (usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined,
            render: ({ usage }, theme) =>
                theme.fg("muted", `CH ${formatPercent(usage.cacheHitRate ?? 0)}`),
        },
        {
            keep: 3,
            width: 2 * (1 + COUNT_WIDTH) + 1,
            hasData: ({ usage }) => usage.input > 0 || usage.output > 0,
            render: ({ usage }, theme) => counters(theme, ["↑", usage.input], ["↓", usage.output]),
        },
        {
            keep: 4,
            width: COST_WIDTH,
            hasData: ({ usage }) => usage.cost > 0,
            render: ({ usage }, theme) => theme.fg("muted", formatCost(usage.cost)),
        },
        {
            keep: 7,
            width: CONTEXT_WIDTH,
            hasData: () => true,
            render: (current, theme) => renderContextCell(current, theme),
        },
    ];
    if (status.autoCompact) {
        slots.push({
            keep: 6,
            width: 6,
            hasData: () => true,
            render: (_current, theme) => theme.fg("accent", "(auto)"),
        });
    }
    return slots;
}

/** Every slot spends one separator, before it: the first one divides the statistics from the directory. */
function slotsWidth(slots: readonly StatSlot[]): number {
    return slots.reduce((sum, slot) => sum + SEPARATOR_WIDTH + slot.width, 0);
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

function reserveSlots(status: DockStatus, width: number, workspace: boolean): StatSlot[] {
    return fitSlots(statSlots(status), width - (workspace ? MIN_WORKSPACE_WIDTH : 0));
}

/**
 * Where the info row draws the bar before each reserved slot, counted in columns from the right
 * edge, leftmost first. The dock row puts the model on one of these so both rows share a bar.
 */
export function statColumns(status: DockStatus, width: number, workspace: boolean): number[] {
    const slots = reserveSlots(status, width, workspace);
    return slots.map((_slot, index) => slotsWidth(slots.slice(index)));
}

/**
 * Working directory and branch on the left, usage statistics on a grid of reserved slots against
 * the right edge. The grid follows from the terminal width alone and every slot keeps its columns
 * whether or not it has data, so arriving or changing numbers never move a bar or a label.
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

    const reserved = parts.usage ? reserveSlots(status, width, parts.workspace) : [];
    const reservedWidth = slotsWidth(reserved);
    const firstDrawn = reserved.findIndex((slot) => slot.hasData(status));
    const grid = reserved
        .map((slot, index) => {
            if (!slot.hasData(status)) return " ".repeat(SEPARATOR_WIDTH + slot.width);
            // With no directory beside it, the leftmost bar would divide the statistics from nothing.
            const bar =
                index === firstDrawn && !parts.workspace
                    ? " ".repeat(SEPARATOR_WIDTH)
                    : theme.fg("dim", CELL_SEPARATOR);
            return bar + padEnd(slot.render(status, theme), slot.width);
        })
        .join("");
    // Only the context slot is left once even it overflows; its blank leading columns give way first.
    const right =
        firstDrawn < 0
            ? ""
            : visibleWidth(grid) > width
              ? truncateToWidth(grid.trimStart(), width)
              : grid;

    let left = "";
    if (parts.workspace) {
        // Shortened against the whole grid, not the drawn slots, so the directory does not move either.
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
