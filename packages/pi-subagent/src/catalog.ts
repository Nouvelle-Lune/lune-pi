import {
    createBashToolDefinition,
    createCodemodeExtension,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createMcpExtension,
    createPowerShellToolDefinition,
    createReadToolDefinition,
    createToolSearchExtension,
    createWriteToolDefinition,
    DefaultResourceLoader,
    type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { ExtensionTool } from "./extension-tools.ts";

export interface CatalogTool {
    name: string;
    description: string;
    source: "native" | "builtin" | "extension";
}

export interface ToolCatalog {
    tools: CatalogTool[];
    /** Load errors of the built-in extensions; their tools are then missing from `tools`. */
    errors: string[];
}

/** The extensions every run loads; a run loads others only for the extension tools it selects. */
export function runExtensionFactories(): InlineExtension[] {
    return [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()];
}

/**
 * The tools every run can select, read from Pi's own definitions rather than a hardcoded list or
 * the parent's tools: a parent extension that replaces `bash` does not replace the run's native one.
 *
 * MCP tools are missing: they register only once a run's servers connect, which happens in the run.
 */
export async function loadToolCatalog(cwd: string, agentDir: string): Promise<ToolCatalog> {
    const native = [
        createReadToolDefinition(cwd),
        createBashToolDefinition(cwd),
        createEditToolDefinition(cwd),
        createWriteToolDefinition(cwd),
        createGrepToolDefinition(cwd),
        createFindToolDefinition(cwd),
        createLsToolDefinition(cwd),
        createPowerShellToolDefinition(cwd),
    ];
    const tools: CatalogTool[] = native.map((definition) => ({
        name: definition.name,
        description: definition.description,
        source: "native",
    }));

    // Loading the factories registers their tools without a session_start, so no MCP server starts.
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: runExtensionFactories(),
    });

    await loader.reload({ resolveProjectTrust: async () => false });

    const result = loader.getExtensions();

    for (const extension of result.extensions) {
        for (const tool of extension.tools.values()) {
            if (!tools.some((known) => known.name === tool.definition.name)) {
                tools.push({
                    name: tool.definition.name,
                    description: tool.definition.description,
                    source: "builtin",
                });
            }
        }
    }

    return {
        tools,
        errors: result.errors.map((error) => `${error.path}: ${error.error}`),
    };
}

/** The catalog with the extension tools that runs can load. */
export function addExtensionTools(
    catalog: ToolCatalog,
    extensionTools: readonly ExtensionTool[],
): ToolCatalog {
    return {
        ...catalog,
        tools: [
            ...catalog.tools,
            ...extensionTools.map(
                (tool): CatalogTool => ({
                    name: tool.name,
                    description: tool.description,
                    source: "extension",
                }),
            ),
        ],
    };
}
