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
});
