/**
 * Public API of lune-memory.
 *
 * The root entry stays light: it loads no SQLite, model or server code. MemoryClient loads the
 * local service only when the daemon does not run, and the daemon starts through the CLI.
 */

export type { DaemonInfo } from "./api/daemon-info.ts";
export type { L1Request, NoteUpdateRequest, SearchRequest, WriterRequest } from "./api/requests.ts";
export { DaemonRequestError, DaemonUnavailableError, ensureDaemon } from "./client/connection.ts";
export {
    MemoryClient,
    type MemoryBackend,
    type MemoryClientOptions,
} from "./client/memory-client.ts";
export {
    defaultConfig,
    loadConfig,
    memoryHome,
    normalizeConfig,
    saveConfig,
    type DreamingConfig,
    type HarnessConfig,
    type MemoryConfig,
} from "./core/config.ts";
export { MemoryOperationError } from "./core/errors.ts";
export { memoryPaths, type MemoryPaths } from "./core/paths.ts";
export {
    HARNESSES,
    isHarness,
    MEMORY_CONTEXT_TAG,
    type Harness,
    type Item,
    type ItemKind,
    type ItemScope,
    type ItemStatus,
    type Project,
    type Trust,
} from "./core/types.ts";
export { callMcpTool, MCP_TOOLS, runMcpServer, type McpToolName } from "./integrations/mcp.ts";
export {
    hookCommand,
    hookInstalled,
    installHook,
    isHookHarness,
    mcpAddCommand,
    piInstallCommand,
    removeHook,
    type HookHarness,
    type HookInstallResult,
    type HookSetupOptions,
} from "./integrations/setup.ts";
export type { L1Result } from "./memory/l1.ts";
export type { NoteInput } from "./memory/notes.ts";
export type { SearchHit, SearchResult } from "./memory/search.ts";
export type {
    DreamRequest,
    MemoryLocation,
    MemoryService,
    MemoryStatus,
    ProviderAdded,
    ProviderInfo,
    ProviderInput,
    ProviderList,
    ProviderScan,
} from "./service.ts";
