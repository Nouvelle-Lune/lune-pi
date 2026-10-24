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

export interface CatalogTool {
    name: string;
    description: string;
    source: "native" | "builtin";
}

export interface ToolCatalog {
    tools: CatalogTool[];
    /** Load errors of the built-in extensions; their tools are then missing from `tools`. */
    errors: string[];
}

/** The only extensions a run loads, so the only extension tools the catalog may list. */
export function runExtensionFactories(): InlineExtension[] {
    return [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()];
}

/**
 * The tools a run can select, read from Pi's own definitions rather than a hardcoded list or the
 * parent's tools: a parent extension that replaces `bash` does not replace the run's native one.
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
