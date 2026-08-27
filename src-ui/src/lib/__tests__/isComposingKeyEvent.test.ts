import { describe, expect, test } from 'vitest';
import { isComposingKeyEvent } from '../isComposingKeyEvent';

/**
 * Each branch discriminated on its own: the surface tests set both signals
 * at once, so without these a regression in either branch would survive.
 */
describe('isComposingKeyEvent', () => {
  test('native isComposing alone gates', () => {
    expect(isComposingKeyEvent({ nativeEvent: { isComposing: true } })).toBe(
      true,
    );
  });

  test('legacy keyCode 229 alone gates', () => {
    expect(
      isComposingKeyEvent({
        keyCode: 229,
        nativeEvent: { isComposing: false },
      }),
    ).toBe(true);
  });

  test('a plain Enter gates nothing', () => {
    expect(
      isComposingKeyEvent({ keyCode: 13, nativeEvent: { isComposing: false } }),
    ).toBe(false);
    expect(isComposingKeyEvent({})).toBe(false);
  });
});
