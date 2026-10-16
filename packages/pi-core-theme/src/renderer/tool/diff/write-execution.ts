import {
    createWriteToolDefinition,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolDefinition,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

export const INSTRUMENTED_WRITE_RENDERER = Symbol.for(
    "pi.lune.core.theme.instrumented-write-renderer",
);
export type InstrumentedWriteRenderer = NonNullable<ToolRenderers["renderResult"]> & {
    [INSTRUMENTED_WRITE_RENDERER]?: true;
};

export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;
export type WriteExecutionMeta = {
    fileExistedBeforeWrite: boolean;
    previousContent?: string;
    diffUnavailableReason?: string;
};

export class WriteExecutionMetadataStore {
    readonly entries = new Map<string, WriteExecutionMeta>();
    set(toolCallId: string, metadata: WriteExecutionMeta): void {
        this.entries.delete(toolCallId);
        this.entries.set(toolCallId, metadata);
        while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }
    get(toolCallId: unknown): WriteExecutionMeta | undefined {
        return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
    }
    clear(): void {
        this.entries.clear();
    }
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
    let info;
    try {
        info = await lstat(absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { fileExistedBeforeWrite: false };
        return {
            fileExistedBeforeWrite: true,
            diffUnavailableReason: "unable to inspect the previous file",
        };
    }
    if (!info.isFile())
        return {
            fileExistedBeforeWrite: true,
            diffUnavailableReason: "previous path is not a regular file",
        };
    if (info.size > MAX_COMPARABLE_WRITE_BYTES)
        return {
            fileExistedBeforeWrite: true,
            diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
        };
    try {
        const bytes = await readFile(absolutePath);
        return {
            fileExistedBeforeWrite: true,
            previousContent: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
    } catch {
        return {
            fileExistedBeforeWrite: true,
            diffUnavailableReason: "previous file is not comparable UTF-8 text",
        };
    }
}

/** The native operation hook captures the exact preimage inside Pi's mutation queue. */
export function createWriteMetadataAdapter(
    pi: ExtensionAPI,
    store: WriteExecutionMetadataStore,
    isEnabled: () => boolean,
) {
    let installed = false;
    let owns = false;
    let warnedOwner: string | undefined;
    return {
        owns: () => owns,
        ensure(ctx: ExtensionContext) {
            const tool = pi.getAllTools().find((tool) => tool.name === "write");
            const source = tool?.sourceInfo;
            if (installed) return;
            if (source && source.source !== "builtin") {
                const owner = source.path || source.source;
                if (warnedOwner !== owner) {
                    ctx.ui.notify(
                        `Lune theme: write belongs to ${owner}; retaining its execution and renderer`,
                        "warning",
                    );
                    warnedOwner = owner;
                }
                return;
            }
            const native = createWriteToolDefinition(ctx.cwd);
            const definition: ToolDefinition<
                typeof native.parameters,
                { luneThemeWrite?: WriteExecutionMeta } | undefined
            > = {
                ...native,
                defaultActive: pi.getActiveTools().includes("write"),
                renderResult: native.renderResult
                    ? (result, options, theme, context) =>
                          native.renderResult!(
                              { ...result, details: undefined },
                              options,
                              theme,
                              context,
                          )
                    : undefined,
                async execute(toolCallId, params, signal, onUpdate, current) {
                    if (!isEnabled())
                        return native.execute(toolCallId, params, signal, onUpdate, current);
                    let metadata: WriteExecutionMeta | undefined;
                    const instrumented = createWriteToolDefinition(current.cwd, {
                        operations: {
                            mkdir: (path) => mkdir(path, { recursive: true }).then(() => {}),
                            async writeFile(path, content) {
                                metadata = await capturePreviousContent(path);
                                signal?.throwIfAborted();
                                await writeFile(path, content, "utf8");
                            },
                        },
                    });
                    const result = await instrumented.execute(
                        toolCallId,
                        params,
                        signal,
                        onUpdate,
                        current,
                    );
                    if (metadata) store.set(toolCallId, metadata);
                    return { ...result, details: { luneThemeWrite: metadata } };
                },
            };
            if (definition.renderResult)
                Object.assign(definition.renderResult, { [INSTRUMENTED_WRITE_RENDERER]: true });
            pi.registerTool(definition);
            installed = true;
            owns = true;
        },
    };
}
