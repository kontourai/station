import {
  evidenceMatchesExpectation,
  normalizeTrustBundle,
} from '@kontourai/flow';
import { describe, expect, it } from 'vitest';
import { buildSyntheticTrustBundle } from './trust-bundle.js';

/**
 * Foundation proof for the Flow 1.3.x migration: a Station-asserted synthetic
 * TrustBundle must satisfy a real `trust.bundle` gate expectation through the
 * REAL `@kontourai/flow` matcher (`evidenceMatchesExpectation`) after the same
 * `normalizeTrustBundle` pass `attachEvidence` performs. This pins both the
 * schema shape and the enforced status semantics.
 */
describe('buildSyntheticTrustBundle — real flow matcher', () => {
  const matches = (entry: unknown, expectation: unknown): boolean =>
    Boolean(evidenceMatchesExpectation(entry, expectation));

  // Mirror exactly what `attachEvidence` stores for a trust.bundle file:
  // `normalizeTrustBundle(raw)` returns `{ bundle, bundle_report }`, both of
  // which land on the evidence entry.
  const entryFor = (raw: unknown) => {
    const { bundle, bundle_report } = normalizeTrustBundle(raw) as {
      bundle: unknown;
      bundle_report: unknown;
    };
    return { kind: 'trust.bundle', status: 'attached', bundle, bundle_report };
  };

  it('an `assumed` quality claim satisfies a quality gate (accepted_statuses:[assumed])', () => {
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
      value: 'pass',
    });
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.tests',
        accepted_statuses: ['assumed'],
      },
    };
    expect(matches(entryFor(bundle), expectation)).toBe(true);
  });

  it('does NOT satisfy a gate selecting a different claimType', () => {
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
    });
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.lint',
        accepted_statuses: ['assumed'],
      },
    };
    expect(matches(entryFor(bundle), expectation)).toBe(false);
  });

  it('a `verified` assertion is DOWNGRADED — cannot satisfy accepted_statuses:[verified] without backing', () => {
    // The trust model enforces the status decision: Surface refuses to derive
    // `verified` for a claim with no backing verification evidence/policy/event.
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
      status: 'verified',
    });
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.tests',
        accepted_statuses: ['verified'],
      },
    };
    expect(matches(entryFor(bundle), expectation)).toBe(false);
  });
});
