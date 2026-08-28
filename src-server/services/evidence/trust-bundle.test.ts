import {
  evidenceMatchesExpectation,
  normalizeTrustBundle,
} from '@kontourai/flow';
import { describe, expect, it } from 'vitest';
import { buildSyntheticTrustBundle } from './trust-bundle.js';

/**
 * Foundation proof for the Flow 5.1 trust-bundle contract: a Station-asserted synthetic
 * TrustBundle must satisfy a real `trust.bundle` gate expectation through the
 * REAL `@kontourai/flow` matcher (`evidenceMatchesExpectation`) after the same
 * `normalizeTrustBundle` pass `attachEvidence` performs. This pins both the
 * schema shape and the enforced status semantics.
 */
describe('buildSyntheticTrustBundle — real flow matcher', () => {
  const CLAIM_AT = '2026-08-28T00:00:00.000Z';
  const EVALUATED_AT = '2026-08-28T00:00:01.000Z';
  const matches = (entry: unknown, expectation: unknown): boolean =>
    Boolean(
      evidenceMatchesExpectation(
        entry,
        expectation,
        undefined,
        null,
        EVALUATED_AT,
      ),
    );

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

  it('an `assumed` quality claim satisfies only explicit assumed acceptance', () => {
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
      value: 'pass',
      now: CLAIM_AT,
    });
    const entry = entryFor(bundle);
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.tests',
        accepted_statuses: ['assumed'],
      },
    };
    expect(
      (entry.bundle_report as { claims: Array<{ status?: string }> }).claims[0]
        ?.status,
    ).toBe('assumed');
    expect(Boolean(evidenceMatchesExpectation(entry, expectation))).toBe(false);
    expect(matches(entry, expectation)).toBe(true);
    expect(
      matches(entry, {
        ...expectation,
        bundle_claim: {
          ...expectation.bundle_claim,
          accepted_statuses: ['verified'],
        },
      }),
    ).toBe(false);
  });

  it('does NOT satisfy a gate selecting a different claimType', () => {
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
      now: CLAIM_AT,
    });
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.lint',
        accepted_statuses: ['assumed'],
      },
    };
    const entry = entryFor(bundle);
    expect(
      (entry.bundle_report as { claims: Array<{ status?: string }> }).claims[0]
        ?.status,
    ).toBe('assumed');
    expect(matches(entry, expectation)).toBe(false);
  });

  it('a `verified` assertion is DOWNGRADED — cannot satisfy accepted_statuses:[verified] without backing', () => {
    // The trust model enforces the status decision: Surface refuses to derive
    // `verified` for a claim with no backing verification evidence/policy/event.
    const bundle = buildSyntheticTrustBundle({
      claimType: 'quality.tests',
      subjectId: 'run-1',
      status: 'verified',
      now: CLAIM_AT,
    });
    const expectation = {
      kind: 'trust.bundle',
      bundle_claim: {
        claimType: 'quality.tests',
        accepted_statuses: ['verified'],
      },
    };
    const entry = entryFor(bundle);
    expect(
      (entry.bundle_report as { claims: Array<{ status?: string }> }).claims[0]
        ?.status,
    ).toBe('unknown');
    expect(matches(entry, expectation)).toBe(false);
  });
});
