import { describe, expect, test } from 'vitest';
import {
  createFallowReview,
  evaluateFallowReview,
} from '../fallow-review-status.mjs';

const revision = 'a'.repeat(40);
const reports = [
  {
    kind: 'dead-code',
    summary: { total_issues: 1 },
    unused_exports: [{ path: 'worker.ts', name: 'run' }],
  },
  {
    kind: 'health',
    summary: { functions_above_threshold: 1 },
    findings: [{ path: 'validator.ts', name: 'validate' }],
  },
  {
    kind: 'dupes',
    stats: { clone_groups: 1 },
    clone_groups: [{ instances: [{ file: 'a.ts' }, { file: 'b.ts' }] }],
  },
];

function reviewed() {
  const review = createFallowReview(revision, reports);
  for (const finding of review.findings) {
    finding.status = 'retained';
    finding.rationale = 'Reviewed owner boundary';
    finding.evidence = ['caller.ts:12'];
  }
  return review;
}

describe('Fallow disposition coverage', () => {
  test('a completed analyzer leaves every finding pending', () => {
    expect(
      evaluateFallowReview(
        createFallowReview(revision, reports),
        reports,
        revision,
        true,
      ),
    ).toMatchObject({
      total: 3,
      reviewed: 0,
      pending: 3,
      reviewCompleted: false,
      remediationCompleted: false,
    });
  });

  test('separates reviewed actionable findings from completed remediation', () => {
    const review = reviewed();
    review.findings[0].status = 'action_required';
    expect(evaluateFallowReview(review, reports, revision, true)).toMatchObject(
      {
        reviewed: 3,
        pending: 0,
        actionRequired: 1,
        reviewCompleted: true,
        remediationCompleted: false,
      },
    );
    review.findings[0].status = 'fixed';
    expect(
      evaluateFallowReview(review, reports, revision, true)
        .remediationCompleted,
    ).toBe(true);
  });

  test('retains identity across report whitespace, but rejects changed observations', () => {
    expect(
      evaluateFallowReview(
        reviewed(),
        JSON.parse(JSON.stringify(reports, null, 4)),
        revision,
        true,
      ).reviewCompleted,
    ).toBe(true);
    const changed = structuredClone(reports);
    changed[0].unused_exports![0].name = 'different';
    expect(() =>
      evaluateFallowReview(reviewed(), changed, revision, true),
    ).toThrow('reports do not match');
  });

  test.each([
    'missing',
    'duplicate',
    'unknown',
    'changed',
    'no-rationale',
    'no-evidence',
    'unknown-status',
  ])('rejects %s dispositions', (fault) => {
    const review = reviewed();
    if (fault === 'missing') review.findings.pop();
    if (fault === 'duplicate') review.findings[1] = review.findings[0];
    if (fault === 'unknown') review.findings[0].id = 'foreign';
    if (fault === 'changed') review.findings[0].kind = 'different';
    if (fault === 'no-rationale') review.findings[0].rationale = ' ';
    if (fault === 'no-evidence') review.findings[0].evidence = [];
    if (fault === 'unknown-status') review.findings[0].status = 'ignored';
    expect(() =>
      evaluateFallowReview(review, reports, revision, true),
    ).toThrow();
  });

  test('rejects stale and dirty source even with every disposition present', () => {
    expect(() =>
      evaluateFallowReview(reviewed(), reports, 'b'.repeat(40), true),
    ).toThrow('stale');
    expect(() =>
      evaluateFallowReview(reviewed(), reports, revision, false),
    ).toThrow('dirty');
  });

  test('refuses incomplete inventories rather than reporting zero pending', () => {
    const partial = structuredClone(reports);
    partial[0].unused_exports = [];
    expect(() => createFallowReview(revision, partial)).toThrow('totals');
    expect(() => createFallowReview(revision, reports.slice(1))).toThrow(
      'three',
    );
    expect(() => createFallowReview('HEAD', reports)).toThrow('exact');
  });
});
