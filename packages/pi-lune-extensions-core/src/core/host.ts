/**
 * The only process-global discovery boundary for all Core package copies.
 *
 * Ownership: settings namespaces and file queues are strong maps with explicit
 * release; Panel/Dock registries weakly scope UI objects. Registry factories stay
 * discovery-free, so composition here does not introduce circular imports.
 *
 * Compatibility is structural and protocol-based, never npm-version/class-based.
 * The first caller creates the Host; later copies validate and reuse it. Workers
 * and separate processes have different globals and do not share this state.
 */
import { createSettingsPanelRegistry, type SettingsPanelRegistry } from "../panel/registry.ts";
import { createDockRegistry, type DockRegistry } from "../dock/registry.ts";

/**
 * Package versions may differ; this number changes only for incompatible shared contracts.
 * 2: one settings file per namespace, namespaces keyed by that global file.
 */
export const CORE_HOST_PROTOCOL_VERSION = 2;
const hostKey = Symbol.for("@lune_99/pi-lune-extensions-core/host");

/**
 * Shared runtime contract; changes to service shape/ownership require ABI assessment.
 * Namespace values are opaque here because their interpretation belongs to storage.
 */
export interface CoreHost {
    readonly protocolVersion: number;
    /** Storage sharing must survive distinct dependency copies in the same process. */
    readonly settings: {
        /** Keys are resolved global namespace files; values own trusted/untrusted project entries. */
        readonly namespaces: Map<string, unknown>;
        /** Per-file write tails prevent different namespaces from losing each other's writes. */
        readonly fileQueues: Map<string, Promise<unknown>>;
    };
    readonly panel: SettingsPanelRegistry;
    readonly dock: DockRegistry;
}

function supports(value: unknown, methods: readonly string[]): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        methods.every((method) => typeof Reflect.get(value, method) === "function")
    );
}

// Reject before reuse; overwriting an incompatible Host would split already-live owners.
function assertCompatible(value: unknown): asserts value is CoreHost {
    const version =
        value !== null && typeof value === "object"
            ? Reflect.get(value, "protocolVersion")
            : undefined;
    if (version !== CORE_HOST_PROTOCOL_VERSION)
        throw new Error(
            `Incompatible Lune Core Host protocol: loaded=${version}, required=${CORE_HOST_PROTOCOL_VERSION}`,
        );
    const settings = Reflect.get(value as object, "settings");
    if (
        !settings ||
        !supports(settings.namespaces, ["get", "set", "delete", "values"]) ||
        !supports(settings.fileQueues, ["get", "set", "delete"]) ||
        !supports(Reflect.get(value as object, "panel"), [
            "register",
            "getSections",
            "subscribe",
        ]) ||
        !supports(Reflect.get(value as object, "dock"), [
            "registerContribution",
            "attachHost",
            "getHost",
            "hasHost",
            "getContributions",
        ])
    )
        throw new Error("Incompatible Lune Core Host structure");
}

/**
 * Discover/create one lazy Host; loading a Core Pi extension is not a prerequisite.
 *
 * Existing incompatible values remain untouched and cause an explicit error. The
 * outer check covers shared structure; Dock's independent protocol is checked in
 * dock/host.ts so a Dock-only mismatch need not disable Settings or Panel.
 */
export function getCoreHost(): CoreHost {
    const shared = globalThis as typeof globalThis & { [hostKey]?: unknown };
    if (Object.hasOwn(shared, hostKey)) {
        const existing = shared[hostKey];
        assertCompatible(existing);
        return existing;
    }
    const host: CoreHost = {
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        settings: { namespaces: new Map(), fileQueues: new Map() },
        panel: createSettingsPanelRegistry(),
        dock: createDockRegistry(),
    };
    Object.defineProperty(shared, hostKey, { value: host, configurable: true });
    return host;
}
