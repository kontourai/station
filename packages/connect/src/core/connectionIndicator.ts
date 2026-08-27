import type { ConnectionFailureReason, ConnectionStatus } from './types';

/**
 * What the connection indicator renders — station#3297 part 2.
 *
 * `ConnectionStatus` has three colours and, by design, no way to say "this one
 * needs you". `HeaderActions.tsx` recorded the consequence in a comment: "the
 * dot alone can't distinguish an ordinary reconnect from a blocked
 * (credential-required) one — the title does, without expanding
 * ConnectionStatusDot's 3-color contract." A `title` is a hover tooltip, and
 * touch devices have no hover, so on a phone the deciding signal did not
 * exist. This adds the fourth state rather than leaving it in a tooltip.
 */
export type ConnectionIndicatorState =
  | ConnectionStatus
  | 'needs-credential'
  /**
   * station#4512 — a locally-tracked access/pairing request is still open
   * against this endpoint and has not expired. The health probe underneath
   * this looks identical to a dead host (no credential exists yet, so every
   * request 401s), but the two are not the same fact: this one is a healthy
   * host waiting on a human, the other is nothing answering at all.
   * Deliberately the HIGHEST-precedence state below — see
   * `connectionIndicatorState`.
   */
  | 'awaiting-approval'
  /**
   * station#4512 — the host answered, but its identity changed
   * (`identity-mismatch`): a reset/reinstalled host, or a different machine
   * now answering at this address. No amount of retrying fixes this — the
   * remedy is re-pairing (or removing the connection) — so it is its own
   * state rather than the generic `error` a genuinely unreachable host also
   * produces.
   */
  | 'needs-repair';

/**
 * The single derivation behind the indicator's state.
 *
 * Deliberately keyed on the observed failure REASON, not on the coordinator's
 * `blocked` flag. The two agree today — `blocked` is
 * `classifyConnectionFailure(reason) === 'terminal'`, and
 * `authentication-failed` is the only terminal reason — but they mean
 * different things: `blocked` says "the automatic retry ladder has stopped",
 * which is a scheduling fact. Widening the terminal set later (a disclosed
 * follow-up in `connectionFailureClassification.ts`) would silently start
 * labelling other failures "needs pairing" if this read `blocked` instead.
 *
 * A reason with no `error` status is not an indicator state: a stale reason
 * left over from a recovered connection must never keep the badge on screen.
 *
 * `pendingApproval` is an independent, caller-supplied fact (station#1876's
 * locally-persisted pending-exchange record — see
 * `observePendingPairingApproval`), not something derivable from
 * `status`/`reason` alone: a device with an outstanding access request has no
 * credential yet, so its probes fail exactly like a dead host's. It takes
 * PRECEDENCE over every other reading, mirroring `ConnectionBannerSource`'s
 * own `!pendingApproval` gate — while a request is open, nothing this reason
 * says is more true than "still waiting". Callers that never pass it (its
 * default is `false`) are unaffected.
 *
 * `reason === 'awaiting-approval'` reaches the SAME state through a second
 * door: `ConnectionFailureReason`'s own doc comment names this exact case
 * ("a native Station mid-authorization, or an access request nothing has
 * confirmed yet") — a native transport refusal coded `mid_authorization`
 * (`classifyNativeTransportRefusal`) produces this reason directly, with no
 * locally-persisted record for `pendingApproval` to observe at all. Before
 * this, a caller relying only on `pendingApproval` and a native caller
 * producing this reason landed on two DIFFERENT states for what
 * `ConnectionFailureReason`'s vocabulary already calls the same thing — the
 * identical-name-unwired trap this closes.
 */
export function connectionIndicatorState(input: {
  status: ConnectionStatus;
  reason: ConnectionFailureReason | null;
  pendingApproval?: boolean;
}): ConnectionIndicatorState {
  if (
    input.status === 'error' &&
    (input.pendingApproval || input.reason === 'awaiting-approval')
  ) {
    return 'awaiting-approval';
  }
  if (input.status === 'error' && input.reason === 'identity-mismatch') {
    return 'needs-repair';
  }
  return input.status === 'error' && input.reason === 'authentication-failed'
    ? 'needs-credential'
    : input.status;
}

/**
 * The state in words, for composing a control's name. Module-local: nothing
 * outside this file needs the phrase without the composition around it, and
 * an unused barrel export is eager weight in the entry chunk.
 */
function connectionIndicatorStateLabel(
  state: ConnectionIndicatorState,
): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Reconnecting';
    case 'error':
      return "Can't connect";
    case 'idle':
      return 'Not running';
    case 'needs-credential':
      return 'Pairing required';
    case 'awaiting-approval':
      return 'Awaiting approval';
    case 'needs-repair':
      return 'Needs re-pairing';
  }
}

/**
 * The accessible name (and pointer title) for an indicator control.
 *
 * `needs-credential` names the ACTION rather than the state, because the
 * control does something different there — it opens re-pairing rather than
 * the connection list — and a name that hid that would misdescribe the
 * button.
 *
 * The healthy case is deliberately the bare, unchanged 'Manage Stations':
 * this string is the header control's identity in the E2E suite (including an
 * exact `button[title="Manage Stations"]` selector), and there is nothing to
 * add to it when nothing is wrong.
 */
export function connectionIndicatorLabel(
  state: ConnectionIndicatorState,
): string {
  if (state === 'connected') return 'Manage Stations';
  if (state === 'needs-credential') return 'Pair this device again';
  return `Manage Stations — ${connectionIndicatorStateLabel(state)}`;
}

/**
 * A short visible label, for surfaces with room for one.
 *
 * `needs-credential`, `awaiting-approval`, and `needs-repair` get one: each
 * is a state that needs a decision (or, for `awaiting-approval`, is the
 * reason nothing else needs one yet), and text is the channel that survives
 * both a colour-blind reader and a 7px dot. Returning `null` for the rest is
 * what keeps the indicator subtle when there is nothing to do — the "subtle
 * yet noticeable" the issue asks for.
 */
export function connectionIndicatorActionLabel(
  state: ConnectionIndicatorState,
): string | null {
  if (state === 'needs-credential') return 'Pair';
  if (state === 'awaiting-approval') return 'Awaiting approval';
  if (state === 'needs-repair') return 'Needs re-pairing';
  return null;
}
