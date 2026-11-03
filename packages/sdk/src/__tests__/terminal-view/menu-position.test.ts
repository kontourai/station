import { describe, expect, it } from 'vitest';
import { placeMenu } from '../../terminal-view/menu-position';

// The terminal menu opened at the pointer or caret. At 1440x900 a bottom
// terminal is about 200px tall, so a click on its last row put a 240px menu
// past the viewport's bottom edge; at 390px a 180px menu ran off the right.
describe('placeMenu', () => {
  const viewport = { width: 1440, height: 900 };
  const menu = { width: 190, height: 240 };

  it('opens below and right of the point when it fits', () => {
    expect(placeMenu({ x: 300, y: 200 }, menu, viewport)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it('flips above a point near the bottom edge', () => {
    expect(placeMenu({ x: 300, y: 880 }, menu, viewport)).toEqual({
      x: 300,
      y: 640,
    });
  });

  it('flips left of a point near the right edge', () => {
    expect(placeMenu({ x: 1400, y: 200 }, menu, viewport)).toEqual({
      x: 1210,
      y: 200,
    });
  });

  it('stays inside a phone viewport whichever way it flips', () => {
    const phone = { width: 390, height: 844 };
    for (const at of [
      { x: 380, y: 830 },
      { x: 5, y: 5 },
      { x: 200, y: 120 },
    ]) {
      const placed = placeMenu(at, { width: 180, height: 400 }, phone);
      expect(placed.x).toBeGreaterThanOrEqual(8);
      expect(placed.y).toBeGreaterThanOrEqual(8);
      expect(placed.x + 180).toBeLessThanOrEqual(390 - 8);
      expect(placed.y + 400).toBeLessThanOrEqual(844 - 8);
    }
  });
});
