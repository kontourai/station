/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FocusEscape,
  isHostChord,
  terminalViewShortcuts,
  viewKeyAction,
} from '../../terminal-view/input/keyboard';

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

describe('terminalViewShortcuts', () => {
  afterEach(() => vi.unstubAllGlobals());

  const actions: Record<string, string> = {
    'terminal.copy': 'copy',
    'terminal.paste': 'paste',
    'terminal.find': 'find',
    'terminal.selectAll': 'select-all',
    'terminal.menu': 'context-menu',
  };

  // The list a host shows must be the keys the view actually keeps.
  it.each([
    ['a Mac', 'MacIntel', true],
    ['Linux', 'Linux x86_64', false],
  ])('lists the chords the view handles on %s', (_name, platform, mac) => {
    vi.stubGlobal('navigator', { platform });
    const listed = terminalViewShortcuts(mac);
    expect(listed.map((shortcut) => shortcut.id).sort()).toEqual(
      [...Object.keys(actions), 'terminal.leave'].sort(),
    );
    for (const shortcut of listed) {
      if (shortcut.id === 'terminal.leave') continue;
      expect(shortcut.chords).toHaveLength(1);
      const { key, modifiers } = shortcut.chords[0]!;
      const event = new KeyboardEvent('keydown', {
        key,
        metaKey: mac && modifiers.includes('cmd'),
        ctrlKey:
          modifiers.includes('ctrl') || (!mac && modifiers.includes('cmd')),
        shiftKey: modifiers.includes('shift'),
        altKey: modifiers.includes('alt'),
      });
      expect(viewKeyAction(event, true)).toBe(actions[shortcut.id]);
    }
  });
});

describe('isHostChord', () => {
  const chord = (
    key: string,
    mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', true>>,
  ) => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it('leaves Command chords to the page on a Mac and Control chords to the program', () => {
    expect(isHostChord(chord('k', { metaKey: true }), true)).toBe(true);
    expect(isHostChord(chord(',', { metaKey: true }), true)).toBe(true);
    expect(isHostChord(chord('k', { ctrlKey: true }), true)).toBe(false);
    expect(isHostChord(chord('ArrowLeft', { metaKey: true }), true)).toBe(
      false,
    );
  });

  it('leaves Control+Shift letters to the page elsewhere, and plain Control to the program', () => {
    expect(
      isHostChord(chord('D', { ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(isHostChord(chord('d', { ctrlKey: true }), false)).toBe(false);
    expect(isHostChord(chord('k', { ctrlKey: true }), false)).toBe(false);
    expect(
      isHostChord(
        chord('D', { ctrlKey: true, shiftKey: true, altKey: true }),
        false,
      ),
    ).toBe(false);
  });
});
