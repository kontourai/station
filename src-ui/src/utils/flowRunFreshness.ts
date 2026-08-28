import type { FlowRunBinding } from '../contexts/active-chats-state';

/**
 * Whether a bound run sits on a step that declares no gate. The chip and the
 * transcript marker both branch on this, so the rule lives here once rather
 * than being re-derived (and drifting) in each component.
 */
export function isFlowRunUngated(binding: FlowRunBinding): boolean {
  return binding.freshness?.blockedReason === 'ungated-step';
}

/**
 * One phrase describing what a bound Flow run has actually evaluated
 * (archive#189).
 *
 * The Flow-gated chip and the transcript's attach marker used to say only
 * that a run existed. An operator reads that as "the delivery is being
 * gated", but the auto-attached `station-delivery` run starts on a step with
 * no gate, so nothing evaluates it and nothing ever will — the binding is
 * real and the progress it implies is not. Returns `null` when the server
 * reported no freshness, so the caller can say "unknown" rather than guess.
 */
export function describeFlowRunFreshness(
  binding: FlowRunBinding,
): string | null {
  const freshness = binding.freshness;
  if (!freshness) return null;

  // `gateOutcomeCount` is Flow's per-gate-id outcome record, which it REPLACES
  // on re-evaluation — so it counts distinct gates with an outcome, not how
  // many times anything ran. Phrased as "N gate outcomes" for that reason;
  // "evaluated N times" would be a number the data cannot support.
  const state = !(freshness.gateOutcomeCount > 0)
    ? 'never evaluated'
    : freshness.lastEvaluatedAt
      ? `last evaluated ${formatEvaluatedAt(freshness.lastEvaluatedAt)}`
      : `${freshness.gateOutcomeCount} gate outcomes, time unrecorded`;

  if (!isFlowRunUngated(binding)) return state;
  // No backticks: this renders as browser text, where a literal backtick reads
  // as a stray character rather than as code (the CLI pane keeps them).
  return binding.currentStep
    ? `${state} — no gate on step ${binding.currentStep}`
    : `${state} — no gate on the current step`;
}

function formatEvaluatedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}
