import { describe, expect, test } from 'vitest';
import { availablePlacements, effectivePlacement } from '../hooks/useIsMobile';

describe('dock slot placement derivation', () => {
  test('offers bottom only to a coarse pointer or a viewport at most 768px', () => {
    expect(
      availablePlacements({ viewportWidth: 1440, coarsePointer: true }),
    ).toEqual(['bottom']);
    expect(
      availablePlacements({ viewportWidth: 768, coarsePointer: false }),
    ).toEqual(['bottom']);
  });

  test('offers every placement only to a fine desktop device', () => {
    expect(
      availablePlacements({ viewportWidth: 769, coarsePointer: false }),
    ).toEqual(['left', 'right', 'bottom']);
  });

  test('remembers an unavailable desktop preference without applying it on a phone', () => {
    const phone = availablePlacements({
      viewportWidth: 390,
      coarsePointer: true,
    });
    expect(effectivePlacement('right', phone)).toBe('bottom');
    expect(
      effectivePlacement(
        'right',
        availablePlacements({ viewportWidth: 1440, coarsePointer: false }),
      ),
    ).toBe('right');
  });
});
