import { describe, expect, it } from 'vitest';
import {
  findShortcutConflicts,
  type KeyboardShortcut,
} from '../contexts/KeyboardShortcutsContext';

function shortcut(partial: Partial<KeyboardShortcut>): KeyboardShortcut {
  return {
    id: partial.id ?? 'x',
    key: partial.key ?? 'k',
    modifiers: partial.modifiers ?? ['cmd'],
    description: partial.description ?? partial.id ?? 'x',
    handler: () => {},
    ...partial,
  };
}

describe('findShortcutConflicts', () => {
  it('reports two live claims on one chord, ordered by priority', () => {
    const conflicts = findShortcutConflicts([
      shortcut({ id: 'a', priority: 5 }),
      shortcut({ id: 'b', priority: 1 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ambiguous).toBe(false);
    expect(conflicts[0].shortcuts.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('flags a priority tie as ambiguous — registration order decides', () => {
    const [conflict] = findShortcutConflicts([
      shortcut({ id: 'a' }),
      shortcut({ id: 'b' }),
    ]);
    expect(conflict.ambiguous).toBe(true);
  });

  it('treats modifier ORDER as irrelevant to the chord identity', () => {
    // cmd+shift+k and shift+cmd+k are one chord; missing this is how a
    // conflict detector reports clean on a real collision.
    const conflicts = findShortcutConflicts([
      shortcut({ id: 'a', modifiers: ['cmd', 'shift'] }),
      shortcut({ id: 'b', modifiers: ['shift', 'cmd'] }),
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it('a disabled shortcut does not conflict', () => {
    expect(
      findShortcutConflicts([
        shortcut({ id: 'a' }),
        shortcut({ id: 'b', disabled: true }),
      ]),
    ).toEqual([]);
  });

  it('does not mark direct context complements ambiguous', () => {
    const [conflict] = findShortcutConflicts([
      shortcut({ id: 'a', when: 'composerFocused' }),
      shortcut({ id: 'b', when: { not: 'composerFocused' } }),
    ]);
    expect(conflict.ambiguous).toBe(false);
  });

  it('distinct chords never conflict', () => {
    expect(
      findShortcutConflicts([
        shortcut({ id: 'a', key: 'k' }),
        shortcut({ id: 'b', key: 'j' }),
      ]),
    ).toEqual([]);
  });
});
