/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { AccentColorPicker } from '../views/settings/AccentColorPicker';

describe('AccentColorPicker', () => {
  beforeEach(() => {
    deviceSettingsStore.importEnvelope({ version: 1, values: {} });
    document.documentElement.style.removeProperty('--accent-primary');
    document.documentElement.style.removeProperty('--text-on-accent');
  });

  afterEach(() => {
    cleanup();
    deviceSettingsStore.importEnvelope({ version: 1, values: {} });
    document.documentElement.style.removeProperty('--accent-primary');
    document.documentElement.style.removeProperty('--text-on-accent');
  });

  test('applies no --accent-primary override for the default (null) accent', () => {
    render(<AccentColorPicker />);
    expect(
      document.documentElement.style.getPropertyValue('--accent-primary'),
    ).toBe('');
  });

  // station#settings-revamp slice2 review finding 4: previously this DOM
  // side effect only ran inside the click handler, so an accent imported
  // (or changed on another tab) while this component was mounted updated
  // the store's state but left the DOM untouched. It is now a `useEffect`
  // keyed on the store value, so it fires however the value changed.
  test('an out-of-band store change (e.g. an Import Settings action) applies --accent-primary even though it never went through this component', () => {
    render(<AccentColorPicker />);

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { accentColor: '#8b5cf6' },
      });
    });

    expect(
      document.documentElement.style.getPropertyValue('--accent-primary'),
    ).toBe('#8b5cf6');
  });

  test('importing an explicit null accent removes the DOM override', () => {
    deviceSettingsStore.set('accentColor', '#8b5cf6');
    render(<AccentColorPicker />);
    expect(
      document.documentElement.style.getPropertyValue('--accent-primary'),
    ).toBe('#8b5cf6');

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { accentColor: null },
      });
    });

    expect(
      document.documentElement.style.getPropertyValue('--accent-primary'),
    ).toBe('');
  });

  test('clicking a preset swatch applies the DOM override', () => {
    const { getByLabelText } = render(<AccentColorPicker />);
    fireEvent.click(getByLabelText('Accent color #ec4899'));
    expect(
      document.documentElement.style.getPropertyValue('--accent-primary'),
    ).toBe('#ec4899');
  });

  // station#3305 review finding 3: --text-on-accent is a static alias of the
  // BUILT-IN brand's contrast partner (#ffffff under [data-theme="light"]),
  // so applying an accent without it moved the background under every
  // --text-on-accent foreground and left the foreground behind — the shipped
  // #6366f1 preset landed at 4.47:1 there. This component is one of the two
  // application sites; lib/__tests__/accent-contrast.test.ts owns the
  // derivation, and these pin that this site actually goes through it.
  test('stamps the accent contrast partner alongside the accent', () => {
    const { getByLabelText } = render(<AccentColorPicker />);
    fireEvent.click(getByLabelText('Accent color #8b5cf6'));
    expect(
      document.documentElement.style.getPropertyValue('--text-on-accent'),
    ).toBe('#000000');
  });

  test('clearing the accent releases the contrast partner back to the theme', () => {
    deviceSettingsStore.set('accentColor', '#8b5cf6');
    render(<AccentColorPicker />);
    expect(
      document.documentElement.style.getPropertyValue('--text-on-accent'),
    ).toBe('#000000');

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { accentColor: null },
      });
    });

    expect(
      document.documentElement.style.getPropertyValue('--text-on-accent'),
    ).toBe('');
  });
});
