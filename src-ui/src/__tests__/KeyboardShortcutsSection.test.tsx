/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  KeyboardShortcutsProvider,
  type ShortcutWhen,
  setShortcutContext,
} from '../contexts/KeyboardShortcutsContext';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { KeyboardShortcutsSection } from '../views/settings/KeyboardShortcutsSection';

const alphaHandler = vi.fn();
const closeHandler = vi.fn();

function Harness({
  when,
  available = true,
  modal = false,
}: {
  when?: ShortcutWhen;
  available?: boolean;
  modal?: boolean;
}) {
  useKeyboardShortcut(
    'app.alpha',
    'g',
    ['cmd'],
    'Open Alpha',
    alphaHandler,
    available,
    0,
    when,
  );
  useKeyboardShortcut(
    'app.closeWindow',
    'w',
    ['cmd'],
    'Close workspace',
    closeHandler,
  );
  return (
    <>
      <textarea
        aria-label="Composer"
        onFocus={() => setShortcutContext('composerFocused', true)}
        onBlur={() => setShortcutContext('composerFocused', false)}
      />
      <button
        type="button"
        aria-label="Terminal"
        onFocus={() => setShortcutContext('terminalFocused', true)}
        onBlur={() => setShortcutContext('terminalFocused', false)}
      />
      <KeyboardShortcutsSection />
      {modal && (
        <div role="dialog" aria-modal="true" aria-label="Modal fixture" />
      )}
    </>
  );
}

function Editor(props: React.ComponentProps<typeof Harness>) {
  return (
    <KeyboardShortcutsProvider>
      <Harness {...props} />
    </KeyboardShortcutsProvider>
  );
}

function renderEditor(props: React.ComponentProps<typeof Harness> = {}) {
  return render(<Editor {...props} />);
}

describe('KeyboardShortcutsSection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // archive#settings-revamp (archive#1359 convergence): the
    // envelope-backed device-settings store is a module singleton whose
    // in-memory snapshot doesn't automatically resync from a test's own
    // `localStorage.clear` — see `reloadFromStorage`'s doc comment.
    deviceSettingsStore.reloadFromStorage();
    setShortcutContext('composerFocused', false);
    setShortcutContext('terminalFocused', false);
    alphaHandler.mockReset();
    closeHandler.mockReset();
  });

  test('searches plain-language commands and shows friendly contexts', () => {
    renderEditor();
    expect(screen.getByText('Open Alpha')).toBeTruthy();
    expect(screen.getAllByText('No extra condition').length).toBeGreaterThan(0);
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
    // Cancelling records nothing (archive#settings-revamp slice 3 archive#1359
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

  test('the current registration controls conditions, dispatch and whether the editor lists a command', () => {
    const { rerender } = renderEditor({ when: 'composerFocused' });
    const alphaRow = screen.getByText('Open Alpha').closest('article')!;
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    const terminal = screen.getByLabelText('Terminal');
    const options = { key: 'g', ctrlKey: true };
    expect(within(alphaRow).getByText('Composer focused')).toBeTruthy();
    expect(within(alphaRow).getByText('"composerFocused"')).toBeTruthy();
    fireEvent.keyDown(window, options);
    expect(alphaHandler).not.toHaveBeenCalled();

    fireEvent.focus(composer);
    fireEvent.keyDown(composer, options);
    expect(alphaHandler).toHaveBeenCalledTimes(1);
    rerender(<Editor when="terminalFocused" />);
    expect(within(alphaRow).getByText('Terminal focused')).toBeTruthy();
    expect(within(alphaRow).getByText('"terminalFocused"')).toBeTruthy();
    fireEvent.keyDown(composer, options);
    expect(alphaHandler).toHaveBeenCalledTimes(1);

    fireEvent.blur(composer);
    fireEvent.focus(terminal);
    fireEvent.keyDown(terminal, options);
    expect(alphaHandler).toHaveBeenCalledTimes(2);
    rerender(<Editor when="terminalFocused" modal />);
    expect(
      within(alphaRow).getByText(/Open dialogs pause shortcuts/),
    ).toBeTruthy();
    fireEvent.keyDown(terminal, options);
    expect(alphaHandler).toHaveBeenCalledTimes(2);

    rerender(<Editor when="terminalFocused" />);
    fireEvent.click(within(alphaRow).getByRole('button', { name: 'Clear' }));
    expect(within(alphaRow).getByText('Not set')).toBeTruthy();
    fireEvent.keyDown(terminal, options);
    expect(alphaHandler).toHaveBeenCalledTimes(2);
    rerender(<Editor when="terminalFocused" available={false} />);
    expect(screen.queryByText('Open Alpha')).toBeNull();
  });

  test('Space takes standard keyboard events while preserving bare-key input ownership', () => {
    const firstEditor = renderEditor();
    const alpha = screen.getByRole('button', {
      name: 'Shortcut for Open Alpha',
    });
    fireEvent.click(alpha);
    fireEvent.keyDown(alpha, { key: ' ', code: 'Space' });
    expect(alpha.textContent).toBe('Space');
    firstEditor.unmount();
    deviceSettingsStore.reloadFromStorage();
    renderEditor();

    const composer = screen.getByRole('textbox', { name: 'Composer' });
    const binding = { key: ' ', code: 'Space' };
    fireEvent.keyDown(composer, binding);
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Shortcut for Open Alpha' }),
      binding,
    );
    expect(alphaHandler).not.toHaveBeenCalled();
    fireEvent.keyDown(window, binding);
    expect(alphaHandler).toHaveBeenCalledOnce();
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
