import { describe, expect, it } from 'vitest';
import { FocusEscape } from '../../terminal-view/input/keyboard';

const key = (k: string, shiftKey = false) => ({
  key: k,
  shiftKey,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
});

describe('FocusEscape', () => {
  it('leaves the terminal on Escape then Tab, and backwards with Shift', () => {
    let now = 0;
    const focusEscape = new FocusEscape(() => now);
    expect(focusEscape.observe(key('Escape'))).toBeNull();
    now = 400;
    expect(focusEscape.observe(key('Tab'))).toBe('focus-next');
    expect(focusEscape.observe(key('Escape'))).toBeNull();
    expect(focusEscape.observe(key('Shift', true))).toBeNull();
    expect(focusEscape.observe(key('Tab', true))).toBe('focus-previous');
  });

  it('keeps Tab for the program otherwise', () => {
    let now = 0;
    const focusEscape = new FocusEscape(() => now);
    expect(focusEscape.observe(key('Tab'))).toBeNull();
    focusEscape.observe(key('Escape'));
    now = 1500;
    expect(focusEscape.observe(key('Tab'))).toBeNull();
    focusEscape.observe(key('Escape'));
    focusEscape.observe(key('j'));
    expect(focusEscape.observe(key('Tab'))).toBeNull();
  });
});
