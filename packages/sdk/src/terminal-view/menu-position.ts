/** Space kept between a menu and the viewport edge. */
const EDGE = 8;

function fit(start: number, size: number, limit: number): number {
  const flipped = start + size + EDGE > limit ? start - size : start;
  return Math.max(EDGE, Math.min(flipped, limit - size - EDGE));
}

/**
 * Where a menu opened at `at` goes: below and right of it, flipped above or
 * left when it would run past the viewport, and always inside it.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: fit(at.x, size.width, viewport.width),
    y: fit(at.y, size.height, viewport.height),
  };
}
