// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { readMobileVisualViewport } from '../hooks/useMobileVisualViewport';

describe('mobile chat visual viewport', () => {
  test('uses the visual viewport instead of layout viewport while the keyboard is open', () => {
    const target = {
      innerHeight: 844,
      visualViewport: { height: 493, offsetTop: 8 },
    } as unknown as Window;
    expect(readMobileVisualViewport(target)).toEqual({
      height: 493,
      offsetTop: 8,
      bottomInset: 343,
    });
  });

  test('falls back to the layout viewport', () => {
    expect(
      readMobileVisualViewport({ innerHeight: 568 } as unknown as Window),
    ).toEqual({ height: 568, offsetTop: 0, bottomInset: 0 });
  });
});
