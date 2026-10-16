/**
 * Manual ownership entry for callers that cannot use Pi-native bindSettings.
 *
 * Every successful acquireSettings call transfers one lease to the caller, which
 * must release it after detaching dependent UI/subscriptions. No session hooks are
 * installed here, so the caller also supplies the project trust decision. Prefer
 * /settings for ordinary extensions so retirement and trust follow native Pi events.
 */
export { acquireSettings } from "./acquire.ts";
export type { SettingsAcquisitionContext } from "./acquire.ts";
export type { SettingsLease } from "./types.ts";
