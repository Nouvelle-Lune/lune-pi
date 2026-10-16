/**
 * Explicit interactive renderer entry; importing it requires the pi-tui runtime peer.
 *
 * Keep this boundary separate from /panel so declaration-only and non-TUI consumers
 * can import Core without terminal components. panel.ts owns the shared frame and
 * subscriptions; choice-editor.ts owns unsaved selection and cancellable discovery.
 * Opening/closing an interaction never acquires or releases a Settings backend.
 */
export { openSettingsPanel } from "./panel.ts";
