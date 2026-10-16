import { isDeepStrictEqual } from "node:util";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { resultText } from "./output.ts";
import { singleLine, toolSummary } from "./summary.ts";

type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

export type CallStatus = "running" | "done" | "failed" | "cancelled";
export interface NestedCall {
    id?: string;
    name: string;
    rendererName?: string;
    args: unknown;
    status: CallStatus;
    durationMs?: number;
    error?: string;
    result?: ToolResult;
}

export const animationInterval = () => Math.max(300, config.animationIntervalMs);
export const animationFrame = () => Math.floor(Date.now() / animationInterval());
export function overallStatus(statuses: readonly CallStatus[]): CallStatus {
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("running") || !statuses.length) return "running";
    return statuses.includes("cancelled") ? "cancelled" : "done";
}
export function callStatus(partial: boolean, error = false): CallStatus {
    return partial ? "running" : error ? "failed" : "done";
}
const status = (value: unknown): CallStatus =>
    value === "ok" || value === "done"
        ? "done"
        : value === "error" || value === "failed"
          ? "failed"
          : value === "cancelled"
            ? "cancelled"
            : "running";

/** Nested execution events supplement tools that do not publish their own calls in details. */
export class ToolActivity {
    private calls = new Map<string, NestedCall & { startedAt: number; parent: string }>();
    private byParent = new Map<string, NestedCall[]>();
    private versions = new Map<string, number>();
    version(parent: string) {
        return this.versions.get(parent) ?? 0;
    }
    private changed(parent: string) {
        this.versions.set(parent, this.version(parent) + 1);
    }
    start(event: {
        toolCallId: string;
        toolName: string;
        args: unknown;
        parentToolCallId?: string;
    }) {
        if (!event.parentToolCallId) return;
        if (this.calls.has(event.toolCallId)) return;
        const call = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running" as const,
            startedAt: Date.now(),
            parent: event.parentToolCallId,
        };
        this.calls.set(event.toolCallId, call);
        const siblings = this.byParent.get(event.parentToolCallId) ?? [];
        siblings.push(call);
        this.byParent.set(event.parentToolCallId, siblings);
        this.changed(event.parentToolCallId);
    }
    update(event: { toolCallId: string; partialResult: ToolResult }) {
        const call = this.calls.get(event.toolCallId);
        if (!call) return;
        call.result = event.partialResult;
        this.changed(call.parent);
    }
    end(event: { toolCallId: string; isError: boolean; durationMs?: number; result?: ToolResult }) {
        const call = this.calls.get(event.toolCallId);
        if (!call) return;
        call.status = event.isError ? "failed" : "done";
        call.durationMs = event.durationMs ?? Date.now() - call.startedAt;
        call.result = event.result;
        if (event.isError && event.result)
            call.error = singleLine(resultText(event.result).slice(0, 512));
        this.changed(call.parent);
    }
    children(parent: string): NestedCall[] {
        return this.byParent.get(parent) ?? [];
    }
    diffRecords(parent: string) {
        return this.children(parent)
            .filter((call) => call.result && (call.name === "edit" || call.name === "write"))
            .map(({ id, name, args, status, result }) => ({ id, name, args, status, result }));
    }
    finish() {
        for (const call of this.calls.values())
            if (call.status === "running") {
                call.status = "cancelled";
                this.changed(call.parent);
            }
    }
    clear() {
        this.calls.clear();
        this.byParent.clear();
        this.versions.clear();
    }
}

export function nestedCalls(
    args: Record<string, unknown>,
    details: unknown,
    live: readonly NestedCall[],
    partial: boolean,
    isError: boolean,
): NestedCall[] {
    const payload =
        details && typeof details === "object"
            ? (details as { calls?: unknown; luneThemeNestedDiffs?: NestedCall[] })
            : undefined;
    const saved = Array.isArray(payload?.luneThemeNestedDiffs)
        ? payload.luneThemeNestedDiffs.filter((call) => call && typeof call.name === "string")
        : [];
    const records = [...live, ...saved];
    const used = new Set<NestedCall>();
    const match = (name: string, id?: string, parameters?: unknown) => {
        const available = records.filter((call) => !used.has(call));
        const named = available.filter(
            (call) => call.name === name || name.endsWith(`.${call.name}`),
        );
        const found =
            (id ? available.find((call) => call.id === id) : undefined) ??
            (parameters === undefined
                ? named[0]
                : named.find((call) => isDeepStrictEqual(call.args, parameters)));
        if (found)
            for (const call of records)
                if (call === found || (found.id && call.id === found.id)) used.add(call);
        return found;
    };
    if (Array.isArray(payload?.calls)) {
        const described = payload.calls
            .filter((call) => call && typeof call.name === "string")
            .map((call) => {
                const record = match(call.name, call.id);
                return {
                    ...record,
                    id: record?.id ?? call.id,
                    name: call.name,
                    rendererName: record?.name,
                    args: record?.args ?? call.args,
                    status: record?.status ?? status(call.status),
                    durationMs: record?.durationMs ?? call.durationMs,
                    error: typeof call.error === "string" ? call.error : record?.error,
                };
            });
        // Codemode partial details can lag behind execution events, including an empty calls array.
        return [...described, ...live.filter((call) => !used.has(call))];
    }
    const planned = args.tool_uses;
    if (!Array.isArray(planned)) return [...live];
    return planned.map((call) => {
        const name = typeof call?.recipient_name === "string" ? call.recipient_name : "?";
        const record = match(name, undefined, call?.parameters);
        return {
            ...record,
            name,
            rendererName: record?.name,
            args: record?.args ?? call?.parameters,
            status: record?.status ?? (partial ? "running" : isError ? "cancelled" : "done"),
        };
    });
}

export function nestedSummary(call: NestedCall, cwd: string) {
    let args = call.args;
    if (typeof args === "string") {
        try {
            args = JSON.parse(args);
        } catch {
            return singleLine(args);
        }
    }
    return args && typeof args === "object" && !Array.isArray(args)
        ? toolSummary(call.name, args as Record<string, unknown>, cwd)
        : singleLine(call.args);
}
