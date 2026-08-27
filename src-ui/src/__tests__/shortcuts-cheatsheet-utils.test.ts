import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  groupShortcuts,
} from '../components/shortcuts-cheatsheet-utils';
import type { KeyboardShortcut } from '../contexts/KeyboardShortcutsContext';

function shortcut(id: string, description = id): KeyboardShortcut {
  return { id, key: 'x', modifiers: ['cmd'], description, handler: () => {} };
}

describe('categoryLabel', () => {
  it('maps known namespaces to friendly labels', () => {
    expect(categoryLabel('app.settings')).toBe('General');
    expect(categoryLabel('app.newLayout')).toBe('General');
    expect(categoryLabel('nav.projects')).toBe('Navigation');
    expect(categoryLabel('dock.toggle')).toBe('Chat & dock');
    expect(categoryLabel('theme.toggle')).toBe('Appearance');
  });

  it('handles dotless ids matched on the whole id', () => {
    expect(categoryLabel('command-palette')).toBe('General');
  });

  it('falls back to "Other" for unknown namespaces', () => {
    expect(categoryLabel('weird.thing')).toBe('Other');
    expect(categoryLabel('mystery')).toBe('Other');
  });
});

describe('groupShortcuts', () => {
  it('orders known categories first and folds unknown namespaces into "Other" last', () => {
    const groups = groupShortcuts([
      shortcut('zebra.one'),
      shortcut('theme.toggle'),
      shortcut('dock.toggle'),
      shortcut('app.settings'),
      shortcut('alpha.one'),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'General',
      'Chat & dock',
      'Appearance',
      'Other',
    ]);
    // Both unmapped ids land in the single "Other" bucket, registration order kept.
    const other = groups.find((g) => g.label === 'Other');
    expect(other?.items.map((i) => i.id)).toEqual(['zebra.one', 'alpha.one']);
  });

  it('groups multiple shortcuts under one label and preserves item order', () => {
    const groups = groupShortcuts([
      shortcut('app.settings', 'Toggle settings'),
      shortcut('command-palette', 'Open command palette'),
      shortcut('app.newLayout', 'New project'),
    ]);
    const general = groups.find((g) => g.label === 'General');
    expect(general?.items.map((i) => i.description)).toEqual([
      'Toggle settings',
      'Open command palette',
      'New project',
    ]);
  });

  it('returns an empty array for no shortcuts', () => {
    expect(groupShortcuts([])).toEqual([]);
  });
});
