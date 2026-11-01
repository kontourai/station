/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';

function wrapper({ children }: { children: ReactNode }) {
  return <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>;
}

describe('useCloseShortcut', () => {
  test('keeps Cmd/Ctrl+X compatibility and adds Escape ownership', () => {
    const onClose = vi.fn();
    renderHook(() => useCloseShortcut(onClose), { wrapper });

    act(() => {
      const mac = navigator.platform.toUpperCase().includes('MAC');
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'x',
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('does not close the view when Escape originates in an editor', () => {
    const onClose = vi.fn();
    renderHook(() => useCloseShortcut(onClose), { wrapper });
    const input = document.createElement('input');
    document.body.append(input);

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
    input.remove();
  });

  // #4383: Settings › Filter settings, Ctrl+A then Ctrl+X closed Settings and
  // threw the typed filter away instead of cutting it.
  test('Cmd/Ctrl+X inside a text field cuts instead of closing the view', () => {
    const onClose = vi.fn();
    renderHook(() => useCloseShortcut(onClose), { wrapper });
    const input = document.createElement('input');
    input.type = 'search';
    input.value = 'theme';
    document.body.append(input);
    input.focus();
    input.select();

    const mac = navigator.platform.toUpperCase().includes('MAC');
    const cut = new KeyboardEvent('keydown', {
      key: 'x',
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(cut);
    });

    expect(onClose).not.toHaveBeenCalled();
    // Left for the browser's own Cut.
    expect(cut.defaultPrevented).toBe(false);
    input.remove();
  });

  test('Cmd/Ctrl+X on a non-text control still closes the view', () => {
    const onClose = vi.fn();
    renderHook(() => useCloseShortcut(onClose), { wrapper });
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(checkbox);
    checkbox.focus();

    const mac = navigator.platform.toUpperCase().includes('MAC');
    act(() => {
      checkbox.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'x',
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    checkbox.remove();
  });
});
