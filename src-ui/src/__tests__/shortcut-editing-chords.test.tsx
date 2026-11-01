/**
 * @vitest-environment jsdom
 */

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ShortcutsCheatsheet } from '../components/ShortcutsCheatsheet';
import {
  formatShortcutChord,
  KeyboardShortcutsProvider,
  listedShortcuts,
} from '../contexts/KeyboardShortcutsContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';

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

afterEach(() => {
  // Unmount React's trees before removing the nodes this file appended.
  cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
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
});
