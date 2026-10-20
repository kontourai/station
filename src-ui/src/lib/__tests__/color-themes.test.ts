/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyColorTheme } from '../color-theme-apply';
import { COLOR_THEME_FAMILIES } from '../color-theme-catalog';
import {
  COLOR_THEME_OPTIONS,
  resolveColorThemeSelection,
} from '../color-themes';
import { deviceSettingsStore } from '../device-settings-store';

const ENVELOPE_KEY = 'station-device-settings-v1';
const catppuccin = COLOR_THEME_FAMILIES.find((f) => f.id === 'catppuccin')!;

const summary = (input: Parameters<typeof resolveColorThemeSelection>[0]) => {
  const resolved = resolveColorThemeSelection(input);
  return resolved.id === 'station'
    ? 'station'
    : `${resolved.id}/${resolved.darkFlavor.id}/${resolved.accent}`;
};

describe('resolveColorThemeSelection', () => {
  test.each([
    ['nothing stored', {}, 'station'],
    ['station', { colorTheme: 'station' }, 'station'],
    ['a family from a newer client', { colorTheme: 'solarized' }, 'station'],
    ['a non-string', { colorTheme: 42 }, 'station'],
    ['a prototype key', { colorTheme: '__proto__' }, 'station'],
    ['a family alone', { colorTheme: 'catppuccin' }, 'catppuccin/mocha/mauve'],
    [
      'a valid flavor and accent',
      {
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'frappe',
        colorThemeAccent: 'peach',
      },
      'catppuccin/frappe/peach',
    ],
    [
      'the light flavor named as the dark one',
      { colorTheme: 'catppuccin', colorThemeFlavor: 'latte' },
      'catppuccin/mocha/mauve',
    ],
    [
      "another family's flavor and accent",
      {
        colorTheme: 'gruvbox',
        colorThemeFlavor: 'mocha',
        colorThemeAccent: 'mauve',
      },
      'gruvbox/dark/orange',
    ],
    [
      'non-string flavor and accent',
      { colorTheme: 'rose-pine', colorThemeFlavor: 1, colorThemeAccent: {} },
      'rose-pine/main/iris',
    ],
  ] as const)('%s resolves to %s', (_label, input, expected) => {
    expect(summary(input)).toBe(expected);
  });
});

describe('invalid stored or synced values fall back instead of throwing', () => {
  const root = document.documentElement;
  beforeEach(() => {
    localStorage.clear();
    for (const name of [...root.getAttributeNames()])
      root.removeAttribute(name);
    document.head.innerHTML = '';
  });
  afterEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  test('an envelope written by a newer client renders Station', () => {
    localStorage.setItem(
      ENVELOPE_KEY,
      JSON.stringify({
        version: 1,
        values: {
          colorTheme: 'solarized',
          colorThemeFlavor: { nested: true },
          colorThemeAccent: 9,
        },
      }),
    );
    deviceSettingsStore.reloadFromStorage();
    // The store hands the raw value through (it does not know the catalog)...
    expect(deviceSettingsStore.getSnapshot().colorTheme).toBe('solarized');
    // ...and the applier resolves it to Station without throwing.
    expect(applyColorTheme(root, deviceSettingsStore.getSnapshot())).toEqual({
      id: 'station',
    });
    expect(root.hasAttribute('data-color-theme')).toBe(false);
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe('#0a0e13');
  });

  test('account values from a newer server fall back per field', () => {
    const unbind = deviceSettingsStore.bindAccountPreferences(
      {
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'neon',
        colorThemeAccent: 'chartreuse',
      },
      () => {},
    );
    try {
      applyColorTheme(root, deviceSettingsStore.getSnapshot());
      expect(root.getAttribute('data-color-theme')).toBe('catppuccin');
      expect(root.getAttribute('data-color-theme-flavor')).toBe('mocha');
      expect(root.getAttribute('data-color-theme-accent')).toBe('mauve');
    } finally {
      unbind();
    }
  });

  test('an import drops an unknown family and keeps the nullable defaults', () => {
    const { droppedKeys } = deviceSettingsStore.importEnvelope({
      version: 1,
      values: {
        colorTheme: 'solarized',
        colorThemeFlavor: null,
        colorThemeAccent: null,
      },
    });
    expect(droppedKeys).toEqual(['colorTheme']);
    expect(deviceSettingsStore.getSnapshot()).toMatchObject({
      colorTheme: 'station',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
  });

  test('an import refuses flavor and accent ids the account server would refuse', () => {
    // A refused field fails the whole account patch, so the device side
    // holds the same id pattern (COLOR_THEME_ID_PATTERN) as the server.
    const { droppedKeys } = deviceSettingsStore.importEnvelope({
      version: 1,
      values: {
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'Mocha Dark',
        colorThemeAccent: 'a'.repeat(49),
      },
    });
    expect(droppedKeys.sort()).toEqual([
      'colorThemeAccent',
      'colorThemeFlavor',
    ]);
    const kept = deviceSettingsStore.importEnvelope({
      version: 1,
      values: { colorThemeFlavor: 'frappe', colorThemeAccent: 'deep-blue' },
    });
    expect(kept.droppedKeys).toEqual([]);
  });

  test('a device setting change is what the applier stamps', () => {
    deviceSettingsStore.set('colorTheme', 'catppuccin');
    deviceSettingsStore.set('colorThemeFlavor', 'macchiato');
    deviceSettingsStore.set('theme', 'light');
    applyColorTheme(root, deviceSettingsStore.getSnapshot());
    expect(root.getAttribute('data-color-theme-flavor')).toBe('macchiato');
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe(catppuccin.light.roles['--k-bg']);
    // One meta, updated in place.
    deviceSettingsStore.set('theme', 'dark');
    applyColorTheme(root, deviceSettingsStore.getSnapshot());
    const metas = document.head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toBe(
      catppuccin.dark.find((f) => f.id === 'macchiato')!.roles['--k-bg'],
    );
  });
});

describe('COLOR_THEME_OPTIONS', () => {
  test("Station's preview text is the installed token value", () => {
    // Read from the installed package the way theme-rung-contrast.test.ts
    // does: the file is not an `exports` entry.
    const tokens = readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../node_modules/@kontourai/ui/tokens/tokens.css',
      ),
      'utf8',
    );
    const text = (selector: RegExp) =>
      tokens.match(selector)?.[1]?.match(/--k-text:\s*(#[0-9a-f]{6})/i)?.[1];
    const station = COLOR_THEME_OPTIONS[0]!;
    expect(station.id).toBe('station');
    expect(station.preview.dark.text).toBe(text(/^:root\s*\{([^}]*)\}/m));
    expect(station.preview.light.text).toBe(
      text(/^\[data-theme="light"\]\s*\{([^}]*)\}/m),
    );
  });

  test('every family lists its light flavor first and an accent swatch for every flavor', () => {
    for (const option of COLOR_THEME_OPTIONS.slice(1)) {
      const family = COLOR_THEME_FAMILIES.find((f) => f.id === option.id)!;
      expect(option.flavors.map((f) => f.id)).toEqual([
        family.light.id,
        ...family.dark.map((f) => f.id),
      ]);
      for (const accent of option.accents)
        expect(Object.keys(accent.swatches)).toEqual(
          option.flavors.map((f) => f.id),
        );
    }
  });
});
