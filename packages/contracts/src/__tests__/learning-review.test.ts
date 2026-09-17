import { describe, expect, test } from 'vitest';
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
    const outcomes: LearningReviewProjectionOutcome[] = [
      { state: 'restricted' },
      { state: 'unavailable' },
    ];
    expect(outcomes).toEqual([
      { state: 'restricted' },
      { state: 'unavailable' },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain('owner');
  });
});
