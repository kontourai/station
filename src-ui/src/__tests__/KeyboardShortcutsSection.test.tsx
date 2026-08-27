/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { KeyboardShortcutsSection } from '../views/settings/KeyboardShortcutsSection';

const alphaHandler = vi.fn();
const closeHandler = vi.fn();

function Harness() {
  useKeyboardShortcut('app.alpha', 'a', ['cmd'], 'Open Alpha', alphaHandler);
  useKeyboardShortcut(
    'app.closeWindow',
    'w',
    ['cmd'],
    'Close workspace',
    closeHandler,
  );
  return <KeyboardShortcutsSection />;
}

function renderEditor() {
  return render(
    <KeyboardShortcutsProvider>
      <Harness />
    </KeyboardShortcutsProvider>,
  );
}

describe('KeyboardShortcutsSection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // station#settings-revamp slice 3 (#1359 convergence): the
    // envelope-backed device-settings store is a module singleton whose
    // in-memory snapshot doesn't automatically resync from a test's own
    // `localStorage.clear()` — see `reloadFromStorage`'s doc comment.
    deviceSettingsStore.reloadFromStorage();
    alphaHandler.mockReset();
    closeHandler.mockReset();
  });

  test('searches plain-language commands and shows friendly contexts', () => {
    renderEditor();
    expect(screen.getByText('Open Alpha')).toBeTruthy();
    expect(screen.getAllByText('Anywhere in Station').length).toBeGreaterThan(
      0,
    );
    fireEvent.change(screen.getByLabelText('Search keyboard shortcuts'), {
      target: { value: 'close workspace' },
    });
    expect(screen.queryByText('Open Alpha')).toBeNull();
    expect(screen.getByText('Close workspace')).toBeTruthy();
    expect(screen.getByText(/browser may use/i)).toBeTruthy();
  });

  test('captures, explains conflicts, cancels, and replaces atomically', () => {
    renderEditor();
    const alpha = screen.getByRole('button', {
      name: 'Shortcut for Open Alpha',
    });
    fireEvent.click(alpha);
    fireEvent.keyDown(alpha, { key: 'w', ctrlKey: true });

    const dialog = screen.getByRole('dialog', {
      name: 'Shortcut already in use',
    });
    expect(dialog.textContent).toContain('Close workspace');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // Cancelling records nothing (station#settings-revamp slice 3 #1359
    // convergence: shortcut overrides now live in the registry-driven
    // envelope's `shortcutOverrides` entry, not the retired
    // `station.device-settings` root).
    expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({});

    fireEvent.click(alpha);
    fireEvent.keyDown(alpha, { key: 'w', ctrlKey: true });
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Shortcut already in use' }),
      ).getByRole('button', { name: 'Replace' }),
    );

    const bindings = deviceSettingsStore.get('shortcutOverrides');
    expect(bindings['app.alpha']).toEqual({
      key: 'w',
      modifiers: ['cmd'],
    });
    expect(bindings['app.closeWindow']).toBeNull();
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(alphaHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler).not.toHaveBeenCalled();
  });

  test('clears and restores a shortcut', () => {
    renderEditor();
    const alphaRow = screen.getByText('Open Alpha').closest('article');
    if (!alphaRow) throw new Error('Alpha row missing');
    fireEvent.click(within(alphaRow).getByRole('button', { name: 'Clear' }));
    expect(
      within(alphaRow).getByRole('button', {
        name: 'Shortcut for Open Alpha',
      }).textContent,
    ).toBe('Not set');

    fireEvent.click(
      within(alphaRow).getByRole('button', { name: 'Restore default' }),
    );
    expect(
      within(alphaRow).getByRole('button', {
        name: 'Shortcut for Open Alpha',
      }).textContent,
    ).not.toBe('Not set');
  });

  test('is read-only and touch-friendly on mobile', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    renderEditor();

    expect(
      screen.getByText(/Edit them from Station on a computer/i),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Shortcut for Open Alpha' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    delete (window as Partial<Window>).matchMedia;
  });
});
