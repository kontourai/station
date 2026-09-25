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

  test.each([
    {
      innerHeight: 915,
      viewportHeight: 915,
      visibleHeight: 578,
      expectedHeight: 578,
      inset: 337,
    },
    {
      innerHeight: 578,
      viewportHeight: 578,
      visibleHeight: 578,
      expectedHeight: 578,
      inset: 0,
    },
    {
      innerHeight: 915,
      viewportHeight: 915,
      visibleHeight: 915,
      expectedHeight: 915,
      inset: 0,
    },
  ])(
    'intersects native visible bounds without double keyboard subtraction: $inset',
    ({ innerHeight, viewportHeight, visibleHeight, expectedHeight, inset }) => {
      const target = {
        innerWidth: 412,
        innerHeight,
        visualViewport: { height: innerHeight, offsetTop: 0 },
        StationAndroidInsets: {
          safeArea: () =>
            JSON.stringify({
              viewportWidth: 412,
              viewportHeight,
              visibleHeight,
            }),
        },
      } as unknown as Window;
      expect(readMobileVisualViewport(target)).toEqual({
        height: expectedHeight,
        offsetTop: 0,
        bottomInset: inset,
      });
    },
  );

  test('native dimensions scale to CSS pixels and honor a panned visual viewport', () => {
    const target = {
      innerWidth: 412,
      innerHeight: 915,
      visualViewport: { height: 500, offsetTop: 8 },
      StationAndroidInsets: {
        safeArea: () =>
          JSON.stringify({
            viewportWidth: 824,
            viewportHeight: 1830,
            visibleHeight: 1000,
          }),
      },
    } as unknown as Window;
    // 1000 device px at 2x is 500 CSS px of glass below the WebView's top
    // edge. The 8px pan moves which page rows fill that glass, not how much of
    // it is visible, so the height is 500, not 500 - 8.
    expect(readMobileVisualViewport(target)).toEqual({
      height: 500,
      offsetTop: 8,
      bottomInset: 407,
    });
  });

  test('a keyboard pan over an unresized WebView leaves the dock flush with the keyboard', () => {
    // The phone case: the WebView keeps its full 915px layout, the IME covers
    // 337px, and the visual viewport (578px) pans 300px down the page to
    // bring the composer into view. The dock must span exactly the 578px of
    // glass above the keyboard; the old reader subtracted the pan again
    // (278px) and left a 300px band of page between dock and keyboard.
    const target = {
      innerWidth: 412,
      innerHeight: 915,
      visualViewport: { height: 578, offsetTop: 300 },
      StationAndroidInsets: {
        safeArea: () =>
          JSON.stringify({
            viewportWidth: 412,
            viewportHeight: 915,
            visibleHeight: 578,
          }),
      },
    } as unknown as Window;
    expect(readMobileVisualViewport(target)).toEqual({
      height: 578,
      offsetTop: 300,
      bottomInset: 37,
    });
  });

  test.each([
    '{}',
    'bad json',
    '{"viewportWidth":0,"viewportHeight":915,"visibleHeight":400}',
    '{"viewportWidth":412,"viewportHeight":915,"visibleHeight":-1}',
    '{"viewportWidth":412,"viewportHeight":915,"visibleHeight":916}',
  ])('ignores invalid or legacy native geometry: %s', (json) => {
    expect(
      readMobileVisualViewport({
        innerWidth: 412,
        innerHeight: 915,
        StationAndroidInsets: { safeArea: () => json },
      } as unknown as Window),
    ).toEqual({ height: 915, offsetTop: 0, bottomInset: 0 });
  });
});
