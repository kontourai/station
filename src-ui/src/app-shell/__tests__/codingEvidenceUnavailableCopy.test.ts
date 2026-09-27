import type { CodingEvidencePaneUnavailableReason } from '@kontourai/station-contracts/workspace-coding-evidence-composition';
import { describe, expect, test } from 'vitest';
import { codingEvidenceUnavailableCopy } from '../codingEvidenceUnavailableCopy';

const REASONS: readonly CodingEvidencePaneUnavailableReason[] = [
  'capability-unavailable',
  'grant-denied',
  'capability-unavailable-and-grant-denied',
];

function descriptionFor(reason: CodingEvidencePaneUnavailableReason): string {
  return codingEvidenceUnavailableCopy({ category: 'diff', reason })
    .description;
}

/**
 * archive#3158. Every case goes through the lookup the renderer calls: the
 * map's three strings were once proven to differ while hardcoding the
 * renderer's lookup to `['capability-unavailable']` restored the exact pre-fix
 * defect with every test green.
 */
describe('coding evidence unavailable copy (station#3158)', () => {
  test('an unreachable capability is not described as a grant problem', () => {
    const copy = descriptionFor('capability-unavailable');
    expect(copy).toContain('cannot reach');
    expect(copy).not.toMatch(/grant/i);
  });

  test('a denied grant is not described as an unreachable capability', () => {
    // The discriminating pair: one is something a user can grant their way
    // out of and the other is not.
    const copy = descriptionFor('grant-denied');
    expect(copy).toContain('not granted');
    expect(copy).not.toMatch(/cannot reach/i);
  });

  test('both causes at once names both, not one of them', () => {
    const copy = descriptionFor('capability-unavailable-and-grant-denied');
    expect(copy).toContain('cannot reach');
    expect(copy).toContain('and the Pane is not granted');
  });

  // The defect this replaced was one sentence for every cause; a future edit
  // that collapses two of them back reads as a passing suite otherwise.
  test('no two reasons share a description', () => {
    expect(new Set(REASONS.map(descriptionFor)).size).toBe(REASONS.length);
  });

  test('the label names the category it was given', () => {
    expect(
      codingEvidenceUnavailableCopy({
        category: 'review',
        reason: 'grant-denied',
      }).label,
    ).toBe('Review evidence unavailable');
  });
});
