/**
 * Consent-gated resolve+execute for one board-emitted `ConsoleIntent`
 * (roadmap #586, part of epic #580, S6) — the server-side half of "click-
 * to-act on the Station session routes through capability-descriptor
 * resolution" (epic DoD). Pure function, no HTTP/Hono coupling, so the
 * consent invariant is directly unit-testable; `routes/operating-state.ts`
 * is a thin Hono wrapper around this.
 *
 * The never-authority / fail-closed resolution itself is
 * `resolveIntentBinding`'s job (real, `@kontourai/console-core`, consumed
 * via `createStationHostIntentBindings`) — this module ONLY adds the one
 * thing resolution intentionally does not do: deciding whether a resolved,
 * confirmation-requiring binding may actually execute. That decision is
 * governed by exactly one rule, matching `@kontourai/console-ui`'s own
 * `bindIntentHandler` consent contract:
 *
 *   - `confirmation === 'never'` -> execute unconditionally (no consent to
 *     gate — matches the CLI router's own `never` semantics).
 *   - otherwise -> execute ONLY when the caller-supplied `consent` is the
 *     literal boolean `true` (strict `===`, never a truthy check) —
 *     `"yes"`, `1`, `{}`, `undefined`, `false`, and every other value
 *     withhold execution exactly like an explicit decline.
 *
 * `execute` is called AT MOST ONCE per `resolveAndExecuteStationBoardIntent`
 * call — there is exactly one call site below, guarded by the rule above.
 */

import type { ConsoleAction, HostIntentBinding } from '@kontourai/console-core';
import { resolveIntentBinding } from '@kontourai/console-core';
import type { StationIntent } from './station-intent-bindings.js';

export interface StationBoardIntentResult {
  bound: boolean;
  /** True only when this call actually invoked the bound `execute`. */
  executed: boolean;
  reason?: string;
}

/**
 * Resolve `intent` against `bindings` and execute it iff the consent rule
 * above is satisfied. Never throws for an unbound or consent-withheld
 * intent — those are ordinary, expected outcomes (`executed: false`), not
 * error conditions. A thrown `execute` still propagates (the caller's
 * problem to handle/report), since silently swallowing an executor's own
 * failure would hide a genuine platform error.
 */
export async function resolveAndExecuteStationBoardIntent(
  intent: StationIntent & Pick<ConsoleAction, 'id' | 'kind'>,
  consent: boolean | undefined,
  bindings: readonly HostIntentBinding<StationIntent>[],
): Promise<StationBoardIntentResult> {
  const resolution = resolveIntentBinding(intent, bindings);
  if (!resolution.bound) {
    return { bound: false, executed: false, reason: resolution.reason };
  }

  const requiresConsent = resolution.confirmation !== 'never';
  if (requiresConsent && consent !== true) {
    return { bound: true, executed: false, reason: 'consent-required' };
  }

  await resolution.execute(intent);
  return { bound: true, executed: true };
}
