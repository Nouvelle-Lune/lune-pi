/**
 * Instance-local cleanup ownership, independent of Settings and UI discovery.
 *
 * Acquire dependencies first and dependents later; disposal runs in reverse order.
 * A ResourceScope does not infer session lifetime: dispose it from the appropriate
 * native hook, or let scopedExtension tie it to session_shutdown. See resources.ts
 * for deduplication, reentrant disposal, subscriptions and aggregated cleanup failures.
 */
export { ResourceScope } from "./resources.ts";
export type { DisposableResource } from "./resources.ts";
export { scopedExtension } from "./scoped-extension.ts";
