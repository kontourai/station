import { describe, expect, test } from 'vitest';
import {
  describeReadFailure,
  READ_FAILURE_FALLBACK,
} from '../describeReadFailure';

/**
 * One derivation for one fact: review found the same "error drawn as
 * empty" defect in three unrelated views, so the sentence a failed read is
 * allowed to show lives here rather than being retyped per view.
 */
describe('describeReadFailure', () => {
  test("prefers a thrown Error's own message — the most specific honest fact", () => {
    expect(describeReadFailure(new Error('skills read failed'))).toBe(
      'skills read failed',
    );
  });

  test('falls back for an Error with a blank message rather than showing nothing', () => {
    expect(describeReadFailure(new Error('   '))).toBe(READ_FAILURE_FALLBACK);
  });

  test('claims nothing about the cause for a non-Error rejection', () => {
    expect(describeReadFailure('boom')).toBe(READ_FAILURE_FALLBACK);
    expect(describeReadFailure({ status: 500 })).toBe(READ_FAILURE_FALLBACK);
    expect(describeReadFailure(true)).toBe(READ_FAILURE_FALLBACK);
  });
});
