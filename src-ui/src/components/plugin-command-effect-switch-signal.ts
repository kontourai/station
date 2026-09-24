/**
 * Tiny, always-loaded seam between the authority switch signal
 * (`AuthorityQueryContext`'s `clearConversationActivity` call, kontourai/station#2309)
 * and the plugin command effect coordinator (kontourai/station#1418, #1419),
 * which is lazily loaded and must not become part of the eager entry bundle.
 *
 * `AuthorityQueryContext` calls {@link notifyPluginCommandEffectAuthoritySwitch}
 * unconditionally on a verified-authority change; if the coordinator was
 * never loaded (no plugin command has run yet), there is nothing to reset
 * and the call is a no-op. If it WAS loaded, it registered its own reset
 * here when constructed.
 */
let handler: (() => void) | null = null;

/** Called once by the coordinator module when it constructs its singleton. */
export function registerPluginCommandEffectAuthoritySwitchHandler(
  fn: () => void,
): void {
  handler = fn;
}

export function notifyPluginCommandEffectAuthoritySwitch(): void {
  handler?.();
}
