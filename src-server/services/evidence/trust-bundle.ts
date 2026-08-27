/**
 * Synthetic Hachure TrustBundle builder (Flow 3.x).
 *
 * Flow's evidence model is Hachure `trust.bundle`: a gate expectation
 * (`kind:'trust.bundle'`) is
 * satisfied by an evidence entry whose `bundle` is schema-valid and whose
 * derived report contains a claim of the selector's `claimType` with a status
 * in `accepted_statuses`. Station asserts a *synthetic* bundle the same way it
 * asserted a claim before — there is no real Hachure/Veritas run behind a
 * command result, so the bundle is Station-asserted.
 *
 * Status semantics are ENFORCED by the trust model, not chosen: Surface's
 * `normalizeTrustBundle`/report derivation downgrades `verified` to `unknown`
 * for any claim lacking backing verification evidence, while preserving
 * `assumed`. So command/quality evidence (a shell command exited 0) is asserted
 * as `assumed` — `verified` is reserved for real Veritas/readiness bundles that
 * carry genuine verification. (`passed` is not a valid hachure status.)
 *
 * The bundle shape here is validated against the real
 * `validateTrustBundleSchema` + `evidenceMatchesExpectation` in the unit test.
 */

/** Hachure claim status enum (subset Station mints). */
export type TrustClaimStatus = 'assumed' | 'verified' | 'proposed';

/** The status Station asserts for command/quality/mcp-ui evidence. */
export const QUALITY_CLAIM_STATUS: TrustClaimStatus = 'assumed';

export interface SyntheticBundleOptions {
  claimType: string;
  /** Defaults to `assumed` (the trust-model-honoring status for asserted evidence). */
  status?: TrustClaimStatus;
  /** Subject the claim is about — defaults to a `change` subject keyed by runId/workdir. */
  subjectType?: string;
  subjectId: string;
  /** Short machine value recorded on the claim (e.g. 'pass' | 'fail'). */
  value?: string;
  /** The behavior/field the claim is over (e.g. 'verify'). */
  fieldOrBehavior?: string;
  /** ISO timestamp; injectable for determinism. */
  now?: string;
}

/**
 * Hachure bundle schema version Station mints. Flow >= 2 rejects the v3
 * bundles Station used to assert outright ("/schemaVersion must be equal to
 * one of the allowed values"), and v3's per-claim `surface` key is now an
 * unknown property ("/claims/0 must NOT have additional properties"). The
 * replacement for `surface` is `facet`.
 */
export const STATION_TRUST_BUNDLE_SCHEMA_VERSION = 5;

/** The Hachure facet Station's asserted claims belong to. */
export const STATION_TRUST_BUNDLE_FACET = 'station';

/** A minimal schema-valid Hachure TrustBundle (schema v5). */
export interface SyntheticTrustBundle {
  schemaVersion: number;
  source: string;
  claims: Array<{
    id: string;
    subjectType: string;
    subjectId: string;
    facet: string;
    claimType: string;
    fieldOrBehavior: string;
    value: string;
    status: TrustClaimStatus;
    createdAt: string;
    updatedAt: string;
  }>;
  evidence: unknown[];
  policies: unknown[];
  events: unknown[];
}

/**
 * Build a schema-valid synthetic TrustBundle asserting a single claim of
 * `claimType` at `status` (default `assumed`). The shape matches hachure
 * `trust-bundle.schema.json` v5 (verified in the unit test against the real
 * `normalizeTrustBundle` + `evidenceMatchesExpectation`).
 */
export function buildSyntheticTrustBundle(
  options: SyntheticBundleOptions,
): SyntheticTrustBundle {
  const now = options.now ?? new Date().toISOString();
  const status = options.status ?? QUALITY_CLAIM_STATUS;
  return {
    schemaVersion: STATION_TRUST_BUNDLE_SCHEMA_VERSION,
    source: 'station/command',
    claims: [
      {
        id: `claim-${options.claimType}-${options.subjectId}`,
        subjectType: options.subjectType ?? 'change',
        subjectId: options.subjectId,
        facet: STATION_TRUST_BUNDLE_FACET,
        claimType: options.claimType,
        fieldOrBehavior: options.fieldOrBehavior ?? 'verify',
        value: options.value ?? 'pass',
        status,
        createdAt: now,
        updatedAt: now,
      },
    ],
    evidence: [],
    policies: [],
    events: [],
  };
}
