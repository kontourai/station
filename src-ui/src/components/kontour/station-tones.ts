import { type SemanticTone, toneForValue } from '@kontourai/ui/react';

// ─── Station domain → Console Kit semantic tones ──────────────────────────────
// The single place Station's domain vocabularies map onto Console Kit's
// semantic scale (positive / caution / negative / active / neutral), per the
// consumer guide's tone-mapping rule. Components must use these helpers (or
// the shared `.flow-gate-card--*` classes in flow-events.css, which encode the
// same gate-verdict mapping in CSS) instead of inventing per-surface mappings.
//
// Gate verdict mapping (shared by chat verdict cards and the run console):
//   pass → positive (--k-positive), route-back → caution (--k-caution),
//   block → negative (--k-negative), wait → neutral.
//
// Deviations from @kontourai/ui's generic `toneForValue` matchers, chosen on
// Station/Veritas semantics (the guide allows product-semantic mapping):
// - readiness `accepted` → caution (a recorded override/bypass is an
//   exception, not a success; toneForValue would say positive)
// - readiness/claim `stale` → caution (recheck signal, not a failure;
//   toneForValue would say negative)
// - claim `disputed`/`unverified`/`assumed` → explicit tones (no matcher
//   covers them — toneMatchers vocabulary gap, logged upstream)

const FLOW_RUN_STATUS_TONES: Record<string, SemanticTone> = {
  completed: 'positive',
  blocked: 'negative',
  failed: 'negative',
  routed_back: 'caution',
  in_progress: 'active',
  active: 'active',
};

/** Flow run lifecycle status (run list + detail header pills). */
export function flowRunStatusTone(
  status: string | null | undefined,
): SemanticTone {
  if (!status) return 'neutral';
  return FLOW_RUN_STATUS_TONES[status] ?? toneForValue(status);
}

const READINESS_STATUS_TONES: Record<string, SemanticTone> = {
  satisfied: 'positive',
  failing: 'negative',
  missing: 'neutral',
  stale: 'caution',
  advisory: 'caution',
  recheckable: 'active',
  accepted: 'caution',
};

/** Veritas readiness requirement status (Station's seven-status derivation). */
export function readinessStatusTone(status: string): SemanticTone {
  return READINESS_STATUS_TONES[status] ?? toneForValue(status);
}

const SURFACE_CLAIM_TONE_OVERRIDES: Record<string, SemanticTone> = {
  disputed: 'negative',
  stale: 'caution',
  assumed: 'caution',
  unverified: 'caution',
};

/** Surface trust-report claim status (trust panel + readiness why-detail). */
export function surfaceClaimTone(status: string): SemanticTone {
  return SURFACE_CLAIM_TONE_OVERRIDES[status] ?? toneForValue(status);
}
