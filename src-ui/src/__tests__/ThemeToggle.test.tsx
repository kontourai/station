/**
 * @vitest-environment jsdom
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ThemeToggle } from '../components/header/ThemeToggle';
import { deviceSettingsStore } from '../lib/device-settings-store';

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => 'Cmd+H',
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    deviceSettingsStore.importEnvelope({ version: 1, values: {} });
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
    deviceSettingsStore.importEnvelope({ version: 1, values: {} });
    document.documentElement.removeAttribute('data-theme');
  });

  test('applies data-theme on mount for the resolved (default) theme', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByTitle('Switch to light mode (Cmd+H)')).toBeTruthy();
  });

  test('clicking the toggle updates data-theme', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // station#settings-revamp slice2 review finding 4: the DOM side effect is
  // keyed on the store VALUE (a `useEffect`), so it fires however the value
  // changed — not only through this component's own click handler.
  test('an out-of-band store change (e.g. an Import Settings action) updates data-theme even though it never went through this component', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { theme: 'light' },
      });
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
