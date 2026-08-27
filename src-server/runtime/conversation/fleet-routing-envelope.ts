/**
 * station#1398 slice 3 — the pure fold from a Dispatch receipt plus this
 * Station's routing context into a `station.fleet-routing-receipt/v1`
 * envelope (`docs/design/inference-fleet.md` §3.4, §4.5).
 *
 * Split from `dispatch-model-policy.ts` because these are the decisions a
 * reviewer needs to be able to read without a Dispatch model in scope, and
 * because the honesty properties here are exactly the ones that need direct
 * unit tests:
 *
 * - Every candidate the router considered appears, admitted or not, with its
 *   evidence provenance intact (§8: the receipt must not lose the
 *   peer-attested/locally-observed distinction).
 * - Every reason a capability did not route appears as a named exclusion.
 *   §4.5's first banned behavior is dropping one silently.
 * - A turn that ended up on a LOCAL candidate after a fleet attempt failed
 *   is reported as `fell-back-to-local`. §4.5's second banned behavior is
 *   falling back with nothing in the receipt; naming it is what makes the
 *   fallback permissible at all.
 * - A failure code says what actually happened. `no-eligible-candidates`
 *   claims an exclusion, so it is only emitted alongside one (station#1556);
 *   candidates that were dispatched and failed get `attempts-failed`, and a
 *   receipt that can support neither claim says so with
 *   `unexplained-no-attempt`.
 * - Nothing from the prompt, the completion, or any message reaches the
 *   envelope. Dispatch's own `planDigest`/`requestDigest` are the only
 *   content-derived values, and they arrive already computed.
 */

import type {
  EmbeddedDispatchReceipt,
  FleetRoutingCandidate,
  FleetRoutingConstraint,
  FleetRoutingExclusion,
  FleetRoutingFailure,
  FleetRoutingReceiptEnvelope,
  FleetRoutingSelection,
  FleetRoutingStreamCapability,
} from '@kontourai/station-contracts/fleet-routing-receipt';

/**
 * §2.7, recorded on every envelope rather than assumed. A Dispatch-routed
 * turn does not stream today: Relay has no native streaming, Station's own
 * Dispatch model declares `streaming: false`, and the fleet serve route
 * answers `buffered`. v1 is scoped to non-interactive work for exactly this
 * reason (§10 OQ-8), and a receipt that cannot say so cannot stop a later
 * change from silently switching a streaming conversation onto this path.
 */
export const FLEET_STREAM_CAPABILITY: FleetRoutingStreamCapability = {
  capable: false,
  reason:
    'A Dispatch-routed turn is buffered end to end: Relay has no native streaming and the fleet serve route returns the completion in full. v1 fleet routing is scoped to non-interactive work.',
};

export interface FleetRoutingContext {
  /** The DECIDING Station — whose log this envelope belongs to. */
  environmentId: string;
  agentName: string;
  /** Every candidate in the plan, local and fleet, in plan order. */
  candidates: FleetRoutingCandidate[];
  /** Every named reason something did not route. */
  exclusions: FleetRoutingExclusion[];
  /** §6.3's channel. Empty in v1; see the contract for why it exists anyway. */
  constraints?: FleetRoutingConstraint[];
}

/** The envelope minus the fields the log seals in (`receiptId`, chain, signature). */
export type UnsealedFleetRoutingEnvelope = Omit<
  FleetRoutingReceiptEnvelope,
  'receiptId' | 'previousReceiptId' | 'schemaVersion' | 'signature'
>;

function selectionFor(candidate: FleetRoutingCandidate): FleetRoutingSelection {
  return {
    candidateId: candidate.candidateId,
    origin: candidate.origin,
    environmentId: candidate.environmentId,
    environmentLabel: candidate.environmentLabel,
    modelId: candidate.modelId,
    evidence: candidate.evidence,
  };
}

/**
 * The one place `no-eligible-candidates` is constructed, so the invariant it
 * carries cannot be bypassed by a second call site (station#1556).
 *
 * `no-eligible-candidates` asserts that policy removed everything, and §4.5
 * requires every removal to be a named exclusion. With no exclusion recorded
 * the code would be an unsupported claim AND its message would point at a
 * list that is not there, so the receipt says what it can actually see:
 * nothing was attempted and nothing explains it.
 */
function nothingAttempted(
  exclusions: FleetRoutingExclusion[],
): FleetRoutingFailure {
  if (exclusions.length === 0) {
    return {
      code: 'unexplained-no-attempt',
      message:
        'Routing ended without a completion, no candidate was attempted, and no exclusion was recorded to say why. This receipt cannot explain itself.',
    };
  }
  return {
    code: 'no-eligible-candidates',
    message:
      'No candidate met this agent’s routing policy, so nothing was attempted. The exclusions below say why for each one.',
  };
}

/**
 * Derives the named routing state. `null` ONLY when the turn ran on a fleet
 * candidate as intended — every other ending, including a perfectly
 * successful local turn that displaced a failed fleet attempt, is a state a
 * user is entitled to see named.
 *
 * `exclusions` is a parameter rather than something this function infers
 * because the codes are not interchangeable labels: `no-eligible-candidates`
 * is a claim ABOUT the exclusion list, so the list has to be in scope to make
 * it (station#1556).
 */
export function deriveFleetRoutingFailure(
  receipt: EmbeddedDispatchReceipt,
  candidates: FleetRoutingCandidate[],
  selection: FleetRoutingSelection | null,
  exclusions: FleetRoutingExclusion[],
): FleetRoutingFailure | null {
  if (receipt.outcome === 'no-eligible-candidates') {
    return nothingAttempted(exclusions);
  }
  if (receipt.outcome === 'budget-exceeded') {
    return {
      code: 'budget-exceeded',
      message:
        'The routing budget stopped this turn before a candidate produced a completion.',
    };
  }
  if (receipt.outcome === 'aborted') {
    return { code: 'aborted', message: 'This turn was aborted while routing.' };
  }
  if (receipt.outcome !== 'succeeded') {
    const fleetAttempted = receipt.attempts.some((attempt) =>
      candidates.some(
        (candidate) =>
          candidate.candidateId === attempt.candidateId &&
          candidate.origin === 'fleet',
      ),
    );
    if (fleetAttempted) {
      return {
        code: 'fleet-attempts-failed',
        message:
          'Every fleet candidate that was attempted failed, and no candidate produced a completion.',
      };
    }
    // Dispatch's `exhausted` outcome means "candidates were tried and none
    // succeeded" — the opposite of an eligibility failure. Reporting it as
    // `no-eligible-candidates` (the pre-#1556 behavior) sent the operator to
    // inspect routing policy for a turn whose model had simply errored, which
    // any single non-retryable local failure produces.
    if (receipt.attempts.length > 0) {
      return {
        code: 'attempts-failed',
        // Deliberately does NOT add "and no fleet candidate was attempted":
        // `fleetAttempted` is matched against this Station's REPLICA of the
        // candidate list, and the replica can diverge from Dispatch's own set
        // (`docs/design/inference-fleet.md`, the L-3 tripwire). Asserting that
        // negative would be an inference from an incomplete list — the class
        // of claim this receipt exists to refuse (station#1556 review, M5).
        message:
          'Every candidate that was attempted failed, and none produced a completion.',
      };
    }
    return nothingAttempted(exclusions);
  }
  if (!selection || selection.origin === 'fleet') return null;

  // Succeeded locally. That is only a plain success if no fleet candidate was
  // ever tried; if one was tried and failed, this turn silently changed where
  // it ran, and §4.5 requires that to be visible.
  const failedFleetAttempts = receipt.attempts.filter(
    (attempt) =>
      attempt.outcome !== 'succeeded' &&
      candidates.some(
        (candidate) =>
          candidate.candidateId === attempt.candidateId &&
          candidate.origin === 'fleet',
      ),
  );
  if (failedFleetAttempts.length === 0) return null;
  const names = failedFleetAttempts
    .map((attempt) => {
      const candidate = candidates.find(
        (entry) => entry.candidateId === attempt.candidateId,
      );
      const where = candidate?.environmentLabel ?? candidate?.environmentId;
      return `${where ?? attempt.candidateId}${attempt.errorCode ? ` (${attempt.errorCode})` : ''}`;
    })
    .join(', ');
  return {
    code: 'fell-back-to-local',
    message: `This turn ran on a local model after a fleet candidate failed: ${names}.`,
  };
}

export function buildFleetRoutingEnvelope(
  context: FleetRoutingContext,
  receipt: EmbeddedDispatchReceipt,
  recordedAt: string,
): UnsealedFleetRoutingEnvelope {
  const admittedIds = new Set(
    context.candidates
      .filter((candidate) => candidate.admitted)
      .map((candidate) => candidate.candidateId),
  );
  // The LAST succeeded attempt is the one that served: Dispatch stops on
  // success, and reading the first would attribute the turn to a candidate
  // that had already failed when the plan carries retries.
  const succeeded = [...receipt.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.outcome === 'succeeded' && admittedIds.has(attempt.candidateId),
    );
  const selectedCandidate = succeeded
    ? context.candidates.find(
        (candidate) => candidate.candidateId === succeeded.candidateId,
      )
    : undefined;
  const selection = selectedCandidate ? selectionFor(selectedCandidate) : null;

  return {
    recordedAt,
    environmentId: context.environmentId,
    agentName: context.agentName,
    dispatch: receipt,
    candidates: context.candidates,
    exclusions: context.exclusions,
    constraints: context.constraints ?? [],
    stream: FLEET_STREAM_CAPABILITY,
    selection,
    failure: deriveFleetRoutingFailure(
      receipt,
      context.candidates,
      selection,
      context.exclusions,
    ),
    interactivity: 'non-interactive',
  };
}
