import { describe, expect, test } from 'vitest';
import { resolveSessionInventoryCompactHost } from '../sessionInventoryCompactHost';

describe('Session inventory compact host', () => {
  test('uses a rail only for desktop bottom/fullscreen and a card for side docks', () => {
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'bottom',
        fullscreen: false,
      }),
    ).toBe('aside');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'left',
        fullscreen: false,
      }),
    ).toBe('card');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'right',
        fullscreen: false,
      }),
    ).toBe('card');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'right',
        fullscreen: true,
      }),
    ).toBe('aside');
  });

  test('never renders a beside-chat body on phone', () => {
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: true,
        dockMode: 'bottom',
        fullscreen: false,
      }),
    ).toBe('full-fallback');
  });
});
