import type { TurnCompletedEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * The finish reasons that PROVE a provider ran a turn to a genuine,
 * self-reported outcome — the clear-authority allowlist.
 *
 * Two independent trust decisions consume this set, and membership grants
 * BOTH authorities at once:
 *
 * - `runtime-auth-health-monitor.ts` (`clearsRuntimeAuthHealth`): a
 *   `turn.completed` with one of these reasons clears a recorded runtime
 *   auth failure for the connection.
 * - `event-store.ts` (`latestCurrentTurnRuntimeErrorEvent` and the batched
 *   `listSessionProjectionEventsForThreads` mirror, station#3485): a
 *   `turn.completed` with one of these reasons, strictly after a
 *   session-scoped `runtime.error`, supersedes that error — the session
 *   stops projecting `failed`.
 *
 * station#3509 fix round MEDIUM 2 (recorded when this set lived inside the
 * auth-health monitor): this is deliberately an ALLOWLIST, not "every
 * well-formed reason minus `'cancelled'`/`'other'`". An exclusion is
 * fail-OPEN — any future member added to the well-formedness vocabulary
 * would silently inherit clear authority too, with no test forcing a
 * decision. Not hypothetical: station#3545's leading fix candidate WAS
 * "accept `'other'`" — considered and rejected in favor of the producer fix
 * (station#3545 itself describes `'other'` as meaning "we do not know," and
 * that description still holds today). station#3587 then added `'other'` to
 * the monitor's separate well-formedness set — this allowlist is exactly why
 * that addition granted `'other'` no clear authority. A new vocabulary
 * member starts with NO clear authority; granting it is a decision the next
 * fixer must make here, explicitly, knowing it widens BOTH consumers.
 */
type ProviderFinishReason = NonNullable<TurnCompletedEvent['finishReason']>;

// The members array is typed against the canonical `finishReason` union
// (`packages/contracts/src/runtime-events.ts`), so a contract rename breaks
// this file at compile time; the exported set stays `ReadonlySet<string>` so
// consumers can probe it with unvalidated event data.
const PROVEN_MEMBERS: readonly ProviderFinishReason[] = [
  'stop',
  'tool-calls',
  'max-tokens',
];

export const PROVIDER_PROVEN_FINISH_REASONS: ReadonlySet<string> = new Set(
  PROVEN_MEMBERS,
);
