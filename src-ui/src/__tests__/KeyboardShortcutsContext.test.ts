/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from 'vitest';
import {
  evaluateShortcutWhen,
  type KeyboardShortcut,
  orderShortcuts,
  shouldIgnoreShortcut,
  withShortcutHint,
} from '../contexts/KeyboardShortcutsContext';

describe('withShortcutHint', () => {
  test('appends a registered shortcut binding', () => {
    expect(withShortcutHint('New chat', 'dock.newChat', () => 'Ctrl+T')).toBe(
      'New chat (Ctrl+T)',
    );
  });

  test('leaves an unregistered shortcut label unchanged', () => {
    expect(withShortcutHint('New chat', 'missing', () => '')).toBe('New chat');
  });

  test('leaves an empty binding label unchanged', () => {
    expect(withShortcutHint('New chat', 'dock.newChat', () => 'Not set')).toBe(
      'New chat',
    );
  });
});

describe('shortcut when expressions', () => {
  const lookup = (key: string) => key === 'composerFocused';

  test('evaluates keys, negation, conjunction, and disjunction', () => {
    expect(evaluateShortcutWhen('composerFocused', lookup)).toBe(true);
    expect(evaluateShortcutWhen({ not: 'composerFocused' }, lookup)).toBe(
      false,
    );
    expect(
      evaluateShortcutWhen(
        { and: ['composerFocused', { not: 'terminalFocused' }] },
        lookup,
      ),
    ).toBe(true);
    expect(
      evaluateShortcutWhen({ or: ['terminalFocused', 'dockFocused'] }, lookup),
    ).toBe(false);
  });

  test('uses boolean identities for empty arrays and rejects unknown keys', () => {
    expect(evaluateShortcutWhen({ and: [] }, lookup)).toBe(true);
    expect(evaluateShortcutWhen({ or: [] }, lookup)).toBe(false);
    expect(evaluateShortcutWhen('futureContext' as never, lookup)).toBe(false);
  });

  test('fails closed beyond depth eight', () => {
    let expression: any = 'composerFocused';
    for (let index = 0; index < 9; index += 1)
      expression = { and: [expression] };
    expect(evaluateShortcutWhen(expression, lookup)).toBe(false);
  });
});

function shortcut(id: string): KeyboardShortcut {
  return {
    id,
    key: 'd',
    modifiers: ['cmd'],
    description: id,
    handler: vi.fn(),
  };
}

describe('dock shortcut guard', () => {
  test('orders local owners before route-level fallbacks', () => {
    const fallback = { ...shortcut('app.escapeUp'), priority: -100 };
    const view = { ...shortcut('view.escape'), priority: 100 };
    expect(orderShortcuts([fallback, view]).map((item) => item.id)).toEqual([
      'view.escape',
      'app.escapeUp',
    ]);
  });

  test('suspends Escape navigation in editable and locally-owned contexts', () => {
    const escapeShortcut = { ...shortcut('app.escapeUp'), key: 'Escape' };
    const input = document.createElement('input');
    const owned = document.createElement('div');
    owned.dataset.escapeOwner = '';
    const child = document.createElement('button');
    owned.append(child);
    document.body.append(input, owned);

    for (const target of [input, child]) {
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      Object.defineProperty(event, 'target', { value: target });
      expect(shouldIgnoreShortcut(escapeShortcut, event)).toBe(true);
    }

    owned.remove();
    const bodyEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(bodyEvent, 'target', { value: document.body });
    expect(shouldIgnoreShortcut(escapeShortcut, bodyEvent)).toBe(false);
    input.remove();
  });
  test('suspends dock shortcuts from editable and modal origins', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(
      shouldIgnoreShortcut(
        shortcut('dock.cancel'),
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }),
      ),
    ).toBe(false);

    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    const editableEvent = new KeyboardEvent('keydown', { bubbles: true });
    Object.defineProperty(editableEvent, 'target', { value: input });
    expect(shouldIgnoreShortcut(shortcut('dock.cancel'), editableEvent)).toBe(
      true,
    );

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    const bodyEvent = new KeyboardEvent('keydown', { bubbles: true });
    Object.defineProperty(bodyEvent, 'target', { value: document.body });
    expect(shouldIgnoreShortcut(shortcut('dock.toggle'), bodyEvent)).toBe(true);
    modal.remove();
    input.remove();
    expect(shouldIgnoreShortcut(shortcut('dock.toggle'), bodyEvent)).toBe(
      false,
    );
  });

  test('blocks the launcher while a modal is open, then allows it from editable active chat', () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    const event = new KeyboardEvent('keydown');
    expect(
      shouldIgnoreShortcut(shortcut('active-command-launcher'), event),
    ).toBe(true);
    modal.remove();
    expect(
      shouldIgnoreShortcut(shortcut('active-command-launcher'), event),
    ).toBe(false);

    const input = document.createElement('textarea');
    document.body.append(input);
    const editableEvent = new KeyboardEvent('keydown', { bubbles: true });
    Object.defineProperty(editableEvent, 'target', { value: input });
    expect(
      shouldIgnoreShortcut(shortcut('active-command-launcher'), editableEvent),
    ).toBe(false);
    input.remove();
  });
});
