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

/**
 * Same-origin browser cookie ("device session") auth is the only mode where
 * a bare `fetch(..., {credentials:'include', keepalive:true})` can actually
 * carry this document's Station credential (kontourai/station#1418, #1419
 * review, MEDIUM). A native shell (Tauri) resolves its bearer through Rust
 * and never sees this fetch call at all — `credentials:'include'` sends
 * nothing for it. A browser-relay (broker) connection authenticates through
 * its own relay exchange, not an ambient cookie scoped to `apiBase`. Outside
 * this one case, a `pagehide` flush must go through the normal authenticated
 * transport instead (best-effort: it may not finish before teardown) and
 * must never claim delivery either way.
 */
export function isPluginCommandEffectCookieAuthEligible(input: {
  isTauri: boolean;
  credentialState: string | null | undefined;
  hasBrokerRoute: boolean;
}): boolean {
  return (
    !input.isTauri &&
    input.credentialState === 'device-session' &&
    !input.hasBrokerRoute
  );
}

let cookieAuthEligible = false;
let cookieAuthHandler: ((eligible: boolean) => void) | null = null;

/**
 * Called once by the coordinator module when it constructs its singleton;
 * immediately delivers whatever the live value already is, in case
 * `notifyPluginCommandEffectCookieAuthEligibility` ran before the
 * coordinator was ever loaded (no plugin command has run yet).
 */
export function registerPluginCommandEffectCookieAuthHandler(
  fn: (eligible: boolean) => void,
): void {
  cookieAuthHandler = fn;
  fn(cookieAuthEligible);
}

/**
 * `AuthorityQueryContext` calls this on every render where the derived
 * eligibility could have changed (credentialState, isTauri, or the broker
 * route). Defaults to `false` — fail closed to the normal authenticated
 * transport — until the first call proves otherwise.
 */
export function notifyPluginCommandEffectCookieAuthEligibility(
  eligible: boolean,
): void {
  cookieAuthEligible = eligible;
  cookieAuthHandler?.(eligible);
}
