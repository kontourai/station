/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { colorThemeSurfaceViolations } from '../branding-theme';
import {
  applyColorTheme,
  COLOR_THEME_FAILED_ATTRIBUTE,
  COLOR_THEME_STYLESHEET_ID,
  renderWhenColorThemeSettled,
  retryColorTheme,
  whenColorThemeStylesheetSettled,
} from '../color-theme-apply';
import { COLOR_THEME_FAMILIES } from '../color-theme-catalog';
import {
  colorThemeBrandSurfaces,
  resolveColorThemeSelection,
} from '../color-theme-selection';
import { COLOR_THEME_OPTIONS } from '../color-themes';
import { deviceSettingsStore } from '../device-settings-store';

const ENVELOPE_KEY = 'station-device-settings-v1';

/** jsdom fetches no stylesheets, so a test plays the browser's load event. */
function settleSheets(event: 'load' | 'error' = 'load'): void {
  for (const link of document.head.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"]:not([data-state])',
  ))
    link.dispatchEvent(new Event(event));
}

function applySettled(
  root: HTMLElement,
  settings: Parameters<typeof applyColorTheme>[1],
) {
  applyColorTheme(root, settings);
  settleSheets();
  return resolveColorThemeSelection(settings);
}
const catppuccin = COLOR_THEME_FAMILIES.find((f) => f.id === 'catppuccin')!;

const summary = (input: Parameters<typeof resolveColorThemeSelection>[0]) => {
  const resolved = resolveColorThemeSelection(input);
  return resolved.id === 'station'
    ? 'station'
    : `${resolved.id}/${resolved.darkFlavor}/${resolved.accent}`;
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
    expect(applySettled(root, deviceSettingsStore.getSnapshot())).toEqual({
      id: 'station',
    });
    expect(root.hasAttribute('data-color-theme')).toBe(false);
    // Station adds no theme-color: a default page is unchanged.
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
  });

  test('returning to Station removes only the theme-color a theme added', () => {
    applySettled(root, {
      theme: 'dark',
      colorTheme: 'nord',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
    expect(
      document.head.querySelectorAll('meta[name="theme-color"]'),
    ).toHaveLength(1);
    applySettled(root, {
      theme: 'dark',
      colorTheme: 'station',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
    // A theme-color something else declared is not ours to remove.
    const foreign = document.createElement('meta');
    foreign.name = 'theme-color';
    foreign.content = '#123456';
    document.head.append(foreign);
    applySettled(root, {
      theme: 'dark',
      colorTheme: 'station',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
    expect(foreign.isConnected).toBe(true);
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
      applySettled(root, deviceSettingsStore.getSnapshot());
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
    applySettled(root, deviceSettingsStore.getSnapshot());
    expect(root.getAttribute('data-color-theme-flavor')).toBe('macchiato');
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe(catppuccin.light.roles['--k-bg']);
    // One meta, updated in place.
    deviceSettingsStore.set('theme', 'dark');
    applySettled(root, deviceSettingsStore.getSnapshot());
    const metas = document.head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toBe(
      catppuccin.dark.find((f) => f.id === 'macchiato')!.roles['--k-bg'],
    );
  });
});

describe('family stylesheets load on demand', () => {
  const root = document.documentElement;
  const base = {
    theme: 'dark' as const,
    colorThemeFlavor: null,
    colorThemeAccent: null,
  };
  beforeEach(() => {
    for (const name of [...root.getAttributeNames()])
      root.removeAttribute(name);
    document.head.innerHTML = '';
  });
  const sheets = () =>
    [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        'link[rel="stylesheet"]',
      ),
    ].map((link) => ({
      id: link.id,
      href: link.getAttribute('href'),
    }));

  test('Station loads no sheet; a family loads only its own, before its attributes apply', () => {
    applyColorTheme(root, { ...base, colorTheme: 'station' });
    expect(sheets()).toEqual([]);
    applyColorTheme(root, { ...base, colorTheme: 'nord' });
    // Requested, not yet in force: no attributes over missing rules.
    expect(sheets()).toEqual([
      { id: '', href: expect.stringMatching(/^\/color-themes\/nord\.css\?v=/) },
    ]);
    expect(root.hasAttribute('data-color-theme')).toBe(false);
    settleSheets();
    expect(sheets()).toEqual([
      {
        id: COLOR_THEME_STYLESHEET_ID,
        href: expect.stringMatching(/^\/color-themes\/nord\.css\?v=/),
      },
    ]);
    expect(root.getAttribute('data-color-theme')).toBe('nord');
    // Back to Station drops the sheet.
    applyColorTheme(root, { ...base, colorTheme: 'station' });
    expect(sheets()).toEqual([]);
    expect(root.hasAttribute('data-color-theme')).toBe(false);
  });

  test('a superseded request never takes over, and a failed sheet claims nothing until a retry loads', () => {
    applySettled(root, { ...base, colorTheme: 'gruvbox' });
    applyColorTheme(root, { ...base, colorTheme: 'tokyo-night' });
    // Back to gruvbox before tokyo-night loaded: its request is dropped.
    applyColorTheme(root, { ...base, colorTheme: 'gruvbox' });
    expect(sheets().map((s) => s.href)).toEqual([
      expect.stringContaining('/gruvbox.css'),
    ]);
    expect(root.getAttribute('data-color-theme')).toBe('gruvbox');
    // rose-pine's sheet 404s: gruvbox stays in force, attributes and sheet.
    applyColorTheme(root, { ...base, colorTheme: 'rose-pine' });
    settleSheets('error');
    expect(root.getAttribute('data-color-theme')).toBe('gruvbox');
    expect(sheets().map((s) => s.href)).toEqual([
      expect.stringContaining('/gruvbox.css'),
    ]);
    // The next apply asks again, and this time it loads.
    applyColorTheme(root, { ...base, theme: 'light', colorTheme: 'rose-pine' });
    settleSheets('load');
    expect(root.getAttribute('data-color-theme')).toBe('rose-pine');
    expect(sheets().map((s) => s.href)).toEqual([
      expect.stringContaining('/rose-pine.css'),
    ]);
  });

  test('a failed sheet is exposed on the root for a picker, and retryColorTheme asks again', () => {
    const failed = () => root.getAttribute(COLOR_THEME_FAILED_ATTRIBUTE);
    applySettled(root, { ...base, colorTheme: 'gruvbox' });
    expect(failed()).toBeNull();
    // A live switch whose sheet 404s.
    applyColorTheme(root, { ...base, colorTheme: 'tokyo-night' });
    settleSheets('error');
    expect(failed()).toBe('tokyo-night');
    expect(root.getAttribute('data-color-theme')).toBe('gruvbox');
    // Retrying the same settings requests it again; failing again keeps it.
    retryColorTheme(root);
    expect(sheets().map((s) => s.href)).toContainEqual(
      expect.stringContaining('/tokyo-night.css'),
    );
    settleSheets('error');
    expect(failed()).toBe('tokyo-night');
    // A retry that loads clears it and claims the theme.
    retryColorTheme(root);
    settleSheets('load');
    expect(failed()).toBeNull();
    expect(root.getAttribute('data-color-theme')).toBe('tokyo-night');
    // Moving to another family, or to Station, clears a failure too.
    applyColorTheme(root, { ...base, colorTheme: 'nord' });
    settleSheets('error');
    expect(failed()).toBe('nord');
    applyColorTheme(root, { ...base, colorTheme: 'rose-pine' });
    expect(failed()).toBeNull();
    settleSheets('error');
    expect(failed()).toBe('rose-pine');
    applyColorTheme(root, { ...base, colorTheme: 'station' });
    expect(failed()).toBeNull();
  });

  test('a startup sheet that fails is not claimed, and is requested again', () => {
    // What startup-theme.js leaves behind: attributes, theme-color and a
    // sheet request for the family.
    const nord = { ...base, colorTheme: 'nord' as const };
    applySettled(root, nord);
    const href = sheets()[0]!.href!;
    document.head.innerHTML = '';
    const startup = document.createElement('link');
    startup.rel = 'stylesheet';
    startup.id = COLOR_THEME_STYLESHEET_ID;
    startup.setAttribute('href', href);
    document.head.append(startup);
    applyColorTheme(root, nord);
    expect(root.getAttribute('data-color-theme')).toBe('nord');
    // It 404s while the app runs: the theme is un-claimed and re-requested.
    startup.dispatchEvent(new Event('error'));
    expect(root.hasAttribute('data-color-theme')).toBe(false);
    expect(root.getAttribute(COLOR_THEME_FAILED_ATTRIBUTE)).toBe('nord');
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(sheets()).toEqual([{ id: '', href }]);
    settleSheets('load');
    expect(root.getAttribute('data-color-theme')).toBe('nord');
    expect(root.hasAttribute(COLOR_THEME_FAILED_ATTRIBUTE)).toBe(false);
    expect(sheets()).toEqual([{ id: COLOR_THEME_STYLESHEET_ID, href }]);
    // A sheet already marked failed (it failed before the app loaded) is the
    // same: not claimed, asked again.
    const failed = document.head.querySelector<HTMLLinkElement>(
      `#${COLOR_THEME_STYLESHEET_ID}`,
    )!;
    failed.dataset.state = 'failed';
    applyColorTheme(root, nord);
    expect(root.hasAttribute('data-color-theme')).toBe(false);
    settleSheets('load');
    expect(root.getAttribute('data-color-theme')).toBe('nord');
  });

  test('a render deferred behind a loading sheet rejects when it throws; an immediate one throws synchronously', async () => {
    // Nothing loading: synchronous, and a throw escapes to the caller.
    const order: string[] = [];
    const done = renderWhenColorThemeSettled(document, () => {
      order.push('render');
    });
    order.push('after');
    await done;
    expect(order).toEqual(['render', 'after']);
    expect(() =>
      renderWhenColorThemeSettled(document, () => {
        throw new Error('no #root');
      }),
    ).toThrow('no #root');
    // A sheet still loading: deferred, and a throw becomes the rejection
    // boot.ts turns into its recovery screen.
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = COLOR_THEME_STYLESHEET_ID;
    document.head.append(link);
    let ran = false;
    const deferred = renderWhenColorThemeSettled(document, () => {
      ran = true;
      throw new Error('render threw');
    });
    expect(ran).toBe(false);
    link.dispatchEvent(new Event('load'));
    await expect(deferred).rejects.toThrow('render threw');
    expect(ran).toBe(true);
  });

  test('the first render waits only for a sheet that is still loading', async () => {
    expect(whenColorThemeStylesheetSettled(document)).toBeNull();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = COLOR_THEME_STYLESHEET_ID;
    document.head.append(link);
    const waiting = whenColorThemeStylesheetSettled(document);
    expect(waiting).not.toBeNull();
    let settled = false;
    void waiting!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    link.dispatchEvent(new Event('load'));
    await waiting;
    expect(settled).toBe(true);
    link.dataset.state = 'loaded';
    expect(whenColorThemeStylesheetSettled(document)).toBeNull();
  });
});

describe('a white-label brand under every light flavor', () => {
  // Station's own light brand: accepted on Station's page, rated again here.
  const shipped = {
    '--k-brand': '#0e7c64',
    '--k-brand-contrast': '#ffffff',
    '--k-action': '#0e7c64',
    '--k-action-contrast': '#ffffff',
    '--k-focus': '#0e7c64',
  };
  const flavors = COLOR_THEME_FAMILIES.map((f) => [f.id, f] as const);
  test.each(flavors)(
    '%s: each slot is rated on its light surfaces',
    (id, f) => {
      const root = document.createElement('div');
      root.dataset.colorTheme = id;
      root.dataset.colorThemeFlavor = f.defaultDarkFlavor;
      const surfaces = colorThemeBrandSurfaces(root, 'light')!;
      expect(surfaces.flavor).toBe(f.light.id);
      expect(surfaces['--k-bg']).toBe(f.light.roles['--k-bg']);
      const failing = new Set(
        colorThemeSurfaceViolations('light', shipped, surfaces).map(
          (v) => v.property,
        ),
      );
      // Whatever fails must really be under its threshold on that page.
      const page = f.light.roles['--k-bg'];
      const ratio = (a: string, b: string) => {
        const l = (hex: string) =>
          [1, 3, 5]
            .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
            .map((c) =>
              c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
        const [x, y] = [l(a), l(b)].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      expect(failing.has('--k-brand')).toBe(
        ratio('#0e7c64', page) < 4.5 ||
          ratio('#0e7c64', f.light.roles['--k-panel']) < 4.5 ||
          ratio('#0e7c64', f.light.roles['--k-panel-raised']) < 4.5,
      );
      // A brand dark enough for every light surface is kept whole.
      expect(
        colorThemeSurfaceViolations(
          'light',
          { '--k-brand': '#0b3d32', '--k-brand-contrast': '#ffffff' },
          surfaces,
        ),
      ).toEqual([]);
    },
  );

  test('a brand that fails on Latte names the slot, surface and ratio', () => {
    const root = document.createElement('div');
    root.dataset.colorTheme = 'catppuccin';
    const [first] = colorThemeSurfaceViolations(
      'light',
      shipped,
      colorThemeBrandSurfaces(root, 'light')!,
    );
    expect(first?.message).toBe(
      "light: --k-brand #0e7c64 on catppuccin/latte --k-bg #e6e9ef = 4.23:1 (needs 4.5:1); the color theme's value is used",
    );
  });

  test('an action without its text is rated against the theme text, like the brand', () => {
    const root = document.createElement('div');
    root.dataset.colorTheme = 'catppuccin';
    const surfaces = colorThemeBrandSurfaces(root, 'light')!;
    expect(surfaces.actionContrast).toBe(
      catppuccin.light.accents.mauve.contrast,
    );
    // A fill dark enough for Latte's surfaces, with a theme text that cannot
    // read on it: both members of each pair are judged the same way.
    const muddy = {
      ...surfaces,
      actionContrast: '#2a2a2a',
      brandContrast: '#2a2a2a',
    };
    const failing = colorThemeSurfaceViolations(
      'light',
      { '--k-brand': '#1e3a8a', '--k-action': '#1e3a8a' },
      muddy,
    ).map((v) => `${v.property} on ${v.surface}`);
    expect(failing).toEqual([
      '--k-brand-contrast on --k-brand',
      '--k-action-contrast on --k-action',
    ]);
    // A text with no fill to rate it against yields, for either pair.
    expect(
      colorThemeSurfaceViolations(
        'light',
        { '--k-action-contrast': '#ffffff', '--k-brand-contrast': '#ffffff' },
        surfaces,
      ).map((v) => v.property),
    ).toEqual(['--k-brand-contrast', '--k-action-contrast']);
  });

  test('Station has no theme surfaces to re-rate against', () => {
    expect(
      colorThemeBrandSurfaces(document.createElement('div'), 'light'),
    ).toBeNull();
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
