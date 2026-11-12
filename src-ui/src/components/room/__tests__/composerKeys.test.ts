import { describe, expect, test } from 'vitest';
import { composerEnterAction } from '../composerKeys';

const enter = { key: 'Enter', shiftKey: false };

describe('composerEnterAction', () => {
  test('a hardware keyboard sends on Enter and adds a line on Shift+Enter', () => {
    expect(composerEnterAction(enter, false)).toBe('send');
    expect(composerEnterAction({ ...enter, shiftKey: true }, false)).toBe(
      'newline',
    );
  });

  test('a touch keyboard never sends on Return', () => {
    expect(composerEnterAction(enter, true)).toBe('newline');
    expect(composerEnterAction({ ...enter, shiftKey: true }, true)).toBe(
      'newline',
    );
  });

  test('Enter that confirms a composition never sends', () => {
    expect(composerEnterAction({ ...enter, isComposing: true }, false)).toBe(
      'ignore',
    );
    expect(composerEnterAction({ ...enter, keyCode: 229 }, false)).toBe(
      'ignore',
    );
  });

  test('other keys are not the composer’s to handle', () => {
    expect(composerEnterAction({ key: 'a', shiftKey: false }, false)).toBe(
      'ignore',
    );
  });
});
