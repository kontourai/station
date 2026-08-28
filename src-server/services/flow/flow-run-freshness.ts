/**
 * Freshness derivation for a Flow run (archive#189 S1).
 *
 * The auto-attached `station-delivery` run shipped a surface that read
 * `step=plan status=active` for an entire delivery in which no gate was ever
 * evaluated. `state.updated_at` cannot tell those apart — it is rewritten by
 * every save, including the attach that created the run — so freshness here is
 * derived only from what a gate evaluation itself writes: the transitions Flow
 * appends in `applyEvaluation`.
 *
 * DISCLOSED GAP: Flow 1.3.0 appends a transition only when an evaluation
 * passes, blocks, or routes back. A `wait` outcome — the common case for a
 * gate whose evidence has not arrived — is merged into `gate_outcomes` with no
 * timestamp anywhere, so a run that HAS been evaluated and is waiting reports
 * `lastEvaluatedAt: null` with `gateOutcomeCount >= 1`. That pair is the
 * honest reading ("evaluated, time unrecorded") and surfaces render it as
 * such; it is not the same as never-evaluated, which is `gateOutcomeCount: 0`.
 * Closing it needs a currency stamp from Flow itself, filed upstream.
 */

import type { FlowRunState } from '@kontourai/flow';
import type { FlowRunFreshness } from '@kontourai/station-contracts/runtime-events';

export type { FlowRunFreshness };

function readStamp(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const at = (candidate as { at?: unknown }).at;
  if (typeof at !== 'string' || at.length === 0) return null;
  return Number.isNaN(Date.parse(at)) ? null : at;
}

/**
 * Evidence entries that still count. A superseded entry has been replaced by a
 * later attach (the fix-and-rerun loop) and is retained only for audit;
 * counting it would inflate how much evidence the run actually stands on.
 */
function activeEvidenceCount(manifestEvidence: unknown): number {
  if (!Array.isArray(manifestEvidence)) return 0;
  return manifestEvidence.filter(
    (entry) => !(entry as { superseded_by?: unknown })?.superseded_by,
  ).length;
}

/**
 * Fold a run's state into the freshness a surface can state honestly.
 *
 * `openGates` is Flow's own `openGates(definition, state)` — the gates
 * declared for the run's CURRENT step. Empty on a still-running run means the
 * step is ungated, which is a dead end rather than progress: bare `evaluate`
 * throws `no gate for current step`, so nothing advances the run.
 */
export function deriveFlowRunFreshness(input: {
  state: FlowRunState;
  openGates: Array<{ id: string; step: string }>;
  manifestEvidence: unknown;
}): FlowRunFreshness {
  const { state } = input;
  const gateOutcomes = Array.isArray(state.gate_outcomes)
    ? state.gate_outcomes
    : [];
  const transitions = Array.isArray(state.transitions) ? state.transitions : [];

  let lastEvaluatedAt: string | null = null;
  let lastEvaluatedMs = Number.NEGATIVE_INFINITY;
  for (const transition of transitions) {
    const stamp = readStamp(transition);
    if (stamp === null) continue;
    const ms = Date.parse(stamp);
    if (ms > lastEvaluatedMs) {
      lastEvaluatedMs = ms;
      lastEvaluatedAt = stamp;
    }
  }

  const ungated = state.status !== 'completed' && input.openGates.length === 0;

  return {
    lastEvaluatedAt,
    ...(ungated ? { blockedReason: 'ungated-step' as const } : {}),
    gateOutcomeCount: gateOutcomes.length,
    evidenceCount: activeEvidenceCount(input.manifestEvidence),
  };
}
