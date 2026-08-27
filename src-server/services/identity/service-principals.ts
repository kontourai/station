/**
 * Declared `kind: 'service'` principals for Station's own unattended,
 * self-invoking background generation paths (station#4075 stage 1).
 *
 * Each of these was previously a hardcoded pseudo-user string threaded
 * straight into a `userId` field — a label nothing derived, indistinguishable
 * on the wire from a real human account.
 *
 * DISCLOSED CHANGE (station#4075 stage 1 review, FINDING 1): the original
 * design kept each `PrincipalRef.id` byte-identical to its old literal
 * (`'invoke-user'`, etc.) so a `userId`/`station.user.id` join would match
 * unchanged. That bare-id scheme let a service id collide with a human id
 * built from the same string (`servicePrincipal('tailscale-serve:alice')`
 * vs. a human derived from provider `tailscale-serve`, subject `alice`).
 * `servicePrincipal` now always prefixes with `service:`, so these ids are
 * `'service:invoke-user'`, `'service:chat-title-generator'`, and
 * `'service:session-summary-generator'` — collision-free identity wins over
 * wire-value stability. The join KEY (`station.user.id`) is unchanged and
 * every FORWARD write uses the new value; this is a pre-release contract
 * with no compat shim, so only historical dev-home rows carry the old bare
 * string. What was always the point stands: the value is now paired with a
 * declared `kind: 'service'` and a human-facing `display`, never invented ad
 * hoc at a call site again.
 */

import { servicePrincipal } from '@kontourai/station-contracts/principal';

/** `routes/agents/invoke-global.ts` — global silent-prompt invocation. */
export const INVOKE_GLOBAL_SERVICE_PRINCIPAL = servicePrincipal(
  'invoke-user',
  'Invoke API',
);

/** `routes/chat/chat-title-generation.ts` — background conversation titling. */
export const CHAT_TITLE_SERVICE_PRINCIPAL = servicePrincipal(
  'chat-title-generator',
  'Chat title generator',
);

/** `routes/chat/session-summary-generation.ts` — on-demand session summaries. */
export const SESSION_SUMMARY_SERVICE_PRINCIPAL = servicePrincipal(
  'session-summary-generator',
  'Session summary generator',
);
