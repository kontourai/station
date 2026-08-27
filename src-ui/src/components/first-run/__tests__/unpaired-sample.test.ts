import { describe, expect, test } from 'vitest';
import { FIRST_RUN_TOUR_STEPS } from '../tour-steps';
import { sampleSurfaceForAnchor } from '../unpaired-sample';

describe('unpaired sample surfaces', () => {
  test('every shipped tour step has a labeled sample card', () => {
    for (const step of FIRST_RUN_TOUR_STEPS) {
      expect(
        sampleSurfaceForAnchor(step.anchor),
        `tour step ${step.id} has no sample surface for ${step.anchor}`,
      ).not.toBeNull();
    }
  });

  test('sample copy does not wear a derived verdict', () => {
    for (const step of FIRST_RUN_TOUR_STEPS) {
      const surface = sampleSurfaceForAnchor(step.anchor);
      const text = `${surface?.eyebrow ?? ''} ${surface?.title ?? ''} ${surface?.body ?? ''}`;
      expect(text).not.toMatch(/\b(verified|ready|pass|passed)\b/i);
    }
  });
});
