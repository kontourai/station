/**
 * @vitest-environment jsdom
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ShortcutsCheatsheet } from '../components/ShortcutsCheatsheet';
import {
  formatShortcutChord,
  KeyboardShortcutsProvider,
} from '../contexts/KeyboardShortcutsContext';
import { listedShortcuts } from '../contexts/listedShortcuts';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { KeyboardShortcutsSection } from '../views/settings/KeyboardShortcutsSection';

function wrapper({ children }: { children: ReactNode }) {
  return <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>;
}

const mac = () => navigator.platform.toUpperCase().includes('MAC');

function pressCtrl(target: EventTarget, key: string) {
  const event = new KeyboardEvent('keydown', {
    key,
    // `dock.cancel` is bound to `ctrl`, which IS Control on every platform.
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function useCancel(onCancel: () => void) {
  useKeyboardShortcut('dock.cancel', 'c', ['ctrl'], 'Cancel request', onCancel);
}

/** A page with its own close (Settings) over the route-level Escape fallback. */
function SettingsLikePage() {
  useKeyboardShortcut(
    'app.escapeUp',
    'Escape',
    [],
    'Go up one level',
    () => undefined,
    true,
    -100,
  );
  useCloseShortcut(() => undefined);
  return <ShortcutsCheatsheet isOpen onClose={() => undefined} />;
}

function ShortcutEditor({
  onSettings,
  onPalette,
}: {
  onSettings: () => void;
  onPalette: () => void;
}) {
  useKeyboardShortcut(
    'app.settings',
    ',',
    ['cmd'],
    'Toggle settings',
    onSettings,
  );
  useKeyboardShortcut(
    'command-palette',
    'k',
    ['cmd'],
    'Open command palette',
    onPalette,
  );
  return <KeyboardShortcutsSection />;
}

afterEach(() => {
  // Unmount React's trees before removing the nodes this file appended.
  cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

test('restoring a displaced shortcut default asks before replacing its current owner', async () => {
  const previous = deviceSettingsStore.getEnvelope();
  deviceSettingsStore.importEnvelope({ version: 1, values: {} });
  const onSettings = vi.fn();
  const onPalette = vi.fn();
  try {
    render(
      <KeyboardShortcutsProvider>
        <ShortcutEditor onSettings={onSettings} onPalette={onPalette} />
      </KeyboardShortcutsProvider>,
    );
    const settings = screen.getByRole('button', {
      name: 'Shortcut for Toggle settings',
    });
    fireEvent.click(settings);
    fireEvent.keyDown(settings, {
      key: 'k',
      metaKey: mac(),
      ctrlKey: !mac(),
    });
    const firstConflict = await screen.findByRole('dialog', {
      name: 'Shortcut already in use',
    });
    fireEvent.click(
      within(firstConflict).getByRole('button', { name: 'Replace' }),
    );
    expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
      'app.settings': { key: 'k', modifiers: ['cmd'] },
      'command-palette': null,
    });

    const paletteRow = screen
      .getByRole('button', { name: 'Shortcut for Open command palette' })
      .closest('article');
    expect(paletteRow).not.toBeNull();
    const restore = within(paletteRow!).getByRole('button', {
      name: 'Restore default',
    });
    fireEvent.click(restore);
    const restoreConflict = await screen.findByRole('dialog', {
      name: 'Shortcut already in use',
    });
    expect(restoreConflict.textContent).toContain('Toggle settings');
    fireEvent.click(
      within(restoreConflict).getByRole('button', { name: 'Cancel' }),
    );
    expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
      'app.settings': { key: 'k', modifiers: ['cmd'] },
      'command-palette': null,
    });

    fireEvent.click(restore);
    const confirmedRestore = await screen.findByRole('dialog', {
      name: 'Shortcut already in use',
    });
    fireEvent.click(
      within(confirmedRestore).getByRole('button', { name: 'Replace' }),
    );
    expect(
      deviceSettingsStore.get('shortcutOverrides')['app.settings'],
    ).toBeNull();
    expect(
      deviceSettingsStore.get('shortcutOverrides')['command-palette'],
    ).toBeUndefined();
    fireEvent.keyDown(document.body, {
      key: 'k',
      metaKey: mac(),
      ctrlKey: !mac(),
    });
    expect(onPalette).toHaveBeenCalledTimes(1);
    expect(onSettings).not.toHaveBeenCalled();
  } finally {
    cleanup();
    deviceSettingsStore.importEnvelope(previous);
  }
});

// #4383: the chat's Cancel request is Ctrl+C. Off a Mac that is Copy, so
// copying a selected passage of the transcript cancelled the running turn.
describe.skipIf(mac())('Ctrl+C cancel versus Copy', () => {
  test('copying selected transcript text does not cancel the turn', () => {
    const onCancel = vi.fn();
    renderHook(() => useCancel(onCancel), { wrapper });
    const answer = document.createElement('p');
    answer.textContent = 'Count from 1 to 40, one number per line.';
    document.body.append(answer);
    const range = document.createRange();
    range.selectNodeContents(answer);
    document.getSelection()?.addRange(range);

    const copy = pressCtrl(answer, 'c');

    expect(onCancel).not.toHaveBeenCalled();
    expect(copy.defaultPrevented).toBe(false);
  });

  test('with nothing selected, Ctrl+C still cancels', () => {
    const onCancel = vi.fn();
    renderHook(() => useCancel(onCancel), { wrapper });

    pressCtrl(document.body, 'c');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('a configured editing chord inside a text field', () => {
  test('Undo in a textarea belongs to the textarea, not a Station undo command', () => {
    const onUndo = vi.fn();
    renderHook(
      () => useKeyboardShortcut('app.undo', 'z', ['cmd'], 'Undo', onUndo),
      { wrapper },
    );
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();

    const undo = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: mac(),
      ctrlKey: !mac(),
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      textarea.dispatchEvent(undo);
    });

    expect(onUndo).not.toHaveBeenCalled();
    expect(undo.defaultPrevented).toBe(false);
  });
});

// #4407: `?` opens the shortcut list — but only outside a text field, where
// it is a character being typed.
describe('a printable-key shortcut', () => {
  function pressQuestionMark(target: EventTarget) {
    const event = new KeyboardEvent('keydown', {
      key: '?',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  test('fires from the page and not from a text field', () => {
    const onHelp = vi.fn();
    renderHook(
      () =>
        useKeyboardShortcut(
          'app.shortcutsHelp',
          '?',
          ['shift'],
          'Keyboard shortcuts help',
          onHelp,
        ),
      { wrapper },
    );
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();

    const typed = pressQuestionMark(composer);
    expect(onHelp).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);

    composer.blur();
    pressQuestionMark(document.body);
    expect(onHelp).toHaveBeenCalledTimes(1);
  });
});

describe('shortcut list spelling and duplicates', () => {
  test('named keys use keycap spelling, not the shouted event name', () => {
    expect(formatShortcutChord([], 'Escape', false)).toBe('Esc');
    expect(formatShortcutChord(['cmd'], 'k', false)).toBe('Ctrl+K');
    expect(formatShortcutChord(['cmd', 'shift'], 'Enter', false)).toBe(
      'Ctrl+Shift+Enter',
    );
  });

  test('a shadowed route fallback with the same name is listed once', () => {
    const owner = {
      id: 'view.escape',
      key: 'Escape',
      modifiers: [],
      description: 'Go up one level',
      handler: () => undefined,
      priority: 100,
    };
    const fallback = { ...owner, id: 'app.escapeUp', priority: -100 };
    expect(listedShortcuts([owner, fallback]).map((s) => s.id)).toEqual([
      'view.escape',
    ]);
    // Rebinding the owner away makes the fallback reachable, so it is listed.
    expect(
      listedShortcuts([{ ...owner, key: 'q' }, fallback]).map((s) => s.id),
    ).toEqual(['view.escape', 'app.escapeUp']);
  });

  test('the cheatsheet lists "Go up one level" once, spelled Esc', () => {
    render(
      <KeyboardShortcutsProvider>
        <SettingsLikePage />
      </KeyboardShortcutsProvider>,
    );

    const rows = screen.getAllByText('Go up one level');
    expect(rows).toHaveLength(1);
    expect(rows[0].parentElement?.textContent).toContain('Esc');
    expect(rows[0].parentElement?.textContent).not.toContain('ESCAPE');
  });

  test('the cheatsheet lists the keys a focused terminal keeps', () => {
    render(
      <KeyboardShortcutsProvider>
        <SettingsLikePage />
      </KeyboardShortcutsProvider>,
    );
    const copy = screen.getByText('Copy selection').parentElement;
    expect(copy?.textContent).toContain(
      mac() ? '⌘C' : formatShortcutChord(['cmd', 'shift'], 'c', false),
    );
    expect(
      screen.getByText('Leave the terminal').parentElement?.textContent,
    ).toContain('Esc then Tab');
  });
});
