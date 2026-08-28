import type { CodingEvidencePaneUnavailableReason } from '@kontourai/station-contracts/workspace-coding-evidence-composition';
import { describe, expect, test } from 'vitest';
import {
  CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS,
  codingEvidenceUnavailableCopy,
} from '../codingEvidenceUnavailableCopy';

const REASONS: readonly CodingEvidencePaneUnavailableReason[] = [
  'capability-unavailable',
  'grant-denied',
  'capability-unavailable-and-grant-denied',
];

describe('coding evidence unavailable copy (station#3158)', () => {
  test('an unreachable capability is not described as a grant problem', () => {
    const copy =
      CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS['capability-unavailable'];
    expect(copy).toContain('cannot reach');
    expect(copy).not.toMatch(/grant/i);
  });

  test('a denied grant is not described as an unreachable capability', () => {
    const copy = CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS['grant-denied'];
    expect(copy).toContain('not granted');
    expect(copy).not.toMatch(/cannot reach/i);
  });

  test('both causes at once names both, not one of them', () => {
    const copy =
      CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS[
        'capability-unavailable-and-grant-denied'
      ];
    expect(copy).toContain('cannot reach');
    expect(copy).toContain('not granted');
  });

// The defect this replaced was one sentence for every cause; a future edit
// that collapses two of them back reads as a passing suite otherwise.
  test('no two reasons share a description', () => {
    const descriptions = REASONS.map(
      (reason) => CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS[reason],
    );
    expect(new Set(descriptions).size).toBe(REASONS.length);
  });
});

/**
 * archive#3158. The map's three strings were proven to differ, and the
 * composition was proven to emit the right reason — but nothing connected
 * them. Hardcoding the renderer's lookup to `['capability-unavailable']`
 * restored the exact pre-fix defect with every test green.
 */
describe('the lookup uses the reason it was handed', () => {
  test.each([
    ['grant-denied', 'not granted'],
    ['capability-unavailable', 'cannot reach'],
    ['capability-unavailable-and-grant-denied', 'and the Pane is not granted'],
  ] as const)('%s describes itself, not another reason', (reason, phrase) => {
    const copy = codingEvidenceUnavailableCopy({ category: 'diff', reason });
    expect(copy.description).toContain(phrase);
  });

  test('a grant-denied pane is never described as unreachable', () => {
// The discriminating case: these two are the pair a user must be able to
// tell apart, because one is something they can grant their way out of
// and the other is not.
    const denied = codingEvidenceUnavailableCopy({
      category: 'diff',
      reason: 'grant-denied',
    });
    expect(denied.description).not.toContain('cannot reach the capability');
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
