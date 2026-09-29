import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  LEARNING_REVIEW_SCHEMA_VERSION,
  LEARNING_REVIEW_STAGE_IDS,
  type LearningReviewProjectionOutcome,
} from '../learning-review.js';

describe('learning review contract', () => {
  test('keeps the lifecycle order explicit and versioned', () => {
    expect(LEARNING_REVIEW_SCHEMA_VERSION).toBe('station.learning-review/v1');
    expect(LEARNING_REVIEW_STAGE_IDS).toEqual([
      'source',
      'candidate',
      'evaluation',
      'decision',
      'activation',
      'effect',
      'retirement',
    ]);
  });

  test('restricted and unavailable outcomes carry no owner identity', () => {
    // Type assertions, checked by `typecheck:contracts`: any field added to
    // either arm (a projection, a sourceRef) fails, optional or not.
    expectTypeOf<
      Extract<LearningReviewProjectionOutcome, { state: 'restricted' }>
    >().toEqualTypeOf<{ readonly state: 'restricted' }>();
    expectTypeOf<
      Extract<LearningReviewProjectionOutcome, { state: 'unavailable' }>
    >().toEqualTypeOf<{ readonly state: 'unavailable' }>();
  });
});
