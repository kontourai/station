/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  APPEARANCE_CACHE_KEY,
  parseAppearanceCache,
} from '../appearance-cache';
import { bindColorThemeToSettings } from '../color-theme-apply';
import {
  deviceSettingsStore,
  resolveBootTheme,
} from '../device-settings-store';

const ENVELOPE_KEY = 'station-device-settings-v1';
const ACCOUNT_CACHE = {
  version: 1,
  source: 'account',
  theme: 'light',
  colorTheme: 'catppuccin',
  colorThemeFlavor: 'frappe',
  colorThemeAccent: 'pink',
};
const DEVICE_VALUES = {
  theme: 'dark',
  colorTheme: 'gruvbox',
  colorThemeFlavor: null,
  colorThemeAccent: null,
};

function seed(cache: unknown, values: unknown = DEVICE_VALUES): void {
  localStorage.setItem(ENVELOPE_KEY, JSON.stringify({ version: 1, values }));
  if (cache !== undefined)
    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      typeof cache === 'string' ? cache : JSON.stringify(cache),
    );
  deviceSettingsStore.reloadFromStorage();
}

const appearance = () => {
  const { theme, colorTheme, colorThemeFlavor, colorThemeAccent } =
    deviceSettingsStore.getSnapshot();
  return { theme, colorTheme, colorThemeFlavor, colorThemeAccent };
};
const { version: _v, source: _s, ...CACHED } = ACCOUNT_CACHE;

describe('the last-applied appearance cache', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  test("an account cache is the boot appearance until the account answers, then the account's values win", () => {
    seed(ACCOUNT_CACHE);
    expect(appearance()).toEqual(CACHED);
    expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
    // The account is loading: still the cached appearance.
    const loading = deviceSettingsStore.bindAccountPreferences(
      undefined,
      () => {},
    );
    expect(appearance()).toEqual(CACHED);
    loading();
    const unbind = deviceSettingsStore.bindAccountPreferences(
      { theme: 'dark', colorTheme: 'nord' },
      () => {},
    );
    expect(appearance()).toEqual({
      theme: 'dark',
      colorTheme: 'nord',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
    expect(deviceSettingsStore.getAppearanceSource()).toBe('account');
    // The boundary unmounting is not a sign-out by itself (an authority
    // re-check after a dropped connection does it too): the account's
    // appearance is held, not the stale boot cache...
    unbind();
    expect(appearance()).toEqual({
      theme: 'dark',
      colorTheme: 'nord',
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });
    expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
    // ...until a definite no-person answer hands it to the device.
    deviceSettingsStore.releaseBootAppearance();
    expect(appearance()).toEqual(DEVICE_VALUES);
    expect(deviceSettingsStore.getAppearanceSource()).toBe('device');
  });

  test.each([
    ['sign-out, then the boundary unmounts', 'release-first'],
    ['the boundary unmounts, then sign-out', 'unmount-first'],
  ] as const)(
    "%s: the signed-out person's appearance is not held",
    (_label, order) => {
      seed(undefined);
      const person = { theme: 'light' as const, colorTheme: 'nord' as const };
      const unbind = deviceSettingsStore.bindAccountPreferences(
        person,
        () => {},
        true,
        'person-a',
      );
      if (order === 'release-first') {
        deviceSettingsStore.releaseBootAppearance();
        unbind();
      } else {
        unbind();
        deviceSettingsStore.releaseBootAppearance();
      }
      expect(deviceSettingsStore.getAppearanceSource()).not.toBe('cache');
      expect(appearance()).toEqual(DEVICE_VALUES);
    },
  );

  test('a release survives the boundary re-binding in the same task, but not a later sign-in', async () => {
    seed(undefined);
    const person = { theme: 'light' as const, colorTheme: 'nord' as const };
    let unbind = deviceSettingsStore.bindAccountPreferences(
      person,
      () => {},
      true,
      'person-a',
    );
    deviceSettingsStore.releaseBootAppearance();
    // The boundary re-binds on every projection change: cleanup, then bind.
    unbind();
    unbind = deviceSettingsStore.bindAccountPreferences(
      person,
      () => {},
      true,
      'person-a',
    );
    unbind();
    expect(appearance()).toEqual(DEVICE_VALUES);
    // Later, the same person signs in again: a reconnect holds as usual.
    await Promise.resolve();
    unbind = deviceSettingsStore.bindAccountPreferences(
      person,
      () => {},
      true,
      'person-a',
    );
    unbind();
    expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
    expect(appearance()).toMatchObject({ theme: 'light', colorTheme: 'nord' });
  });

  test('with no person, the device appearance replaces the cache', () => {
    seed(ACCOUNT_CACHE);
    deviceSettingsStore.releaseBootAppearance();
    expect(appearance()).toEqual(DEVICE_VALUES);
  });

  test('choosing a device appearance yields the cache, even to the stored value', () => {
    seed(ACCOUNT_CACHE);
    deviceSettingsStore.set('colorTheme', 'gruvbox');
    expect(appearance()).toEqual(DEVICE_VALUES);
  });

  test.each([
    ['a device-sourced cache', { ...ACCOUNT_CACHE, source: 'device' }],
    ['a malformed cache', '{nope'],
    ['an unknown version', { ...ACCOUNT_CACHE, version: 2 }],
    ['an invalid mode', { ...ACCOUNT_CACHE, theme: 'sepia' }],
    ['a non-id family', { ...ACCOUNT_CACHE, colorTheme: '<b>' }],
  ])('%s is not read: the device envelope applies', (_label, cache) => {
    seed(cache);
    expect(appearance()).toEqual(DEVICE_VALUES);
  });

  test('the applier records what it rendered and where it came from, but never writes the cache back', () => {
    const root = document.documentElement;
    seed(undefined);
    const stop = bindColorThemeToSettings(root, deviceSettingsStore);
    try {
      expect(
        parseAppearanceCache(localStorage.getItem(APPEARANCE_CACHE_KEY)),
      ).toEqual({ version: 1, source: 'device', ...DEVICE_VALUES });
      const unbind = deviceSettingsStore.bindAccountPreferences(
        {
          theme: 'light',
          colorTheme: 'tokyo-night',
          colorThemeFlavor: 'storm',
        },
        () => {},
      );
      expect(
        parseAppearanceCache(localStorage.getItem(APPEARANCE_CACHE_KEY)),
      ).toEqual({
        version: 1,
        source: 'account',
        theme: 'light',
        colorTheme: 'tokyo-night',
        colorThemeFlavor: 'storm',
        colorThemeAccent: null,
      });
      // Stop rendering first, as a page unload would, then sign out.
      stop();
      unbind();
    } finally {
      stop();
    }
    // A boot from that cache renders it without rewriting it as device data.
    deviceSettingsStore.reloadFromStorage();
    const before = localStorage.getItem(APPEARANCE_CACHE_KEY);
    const again = bindColorThemeToSettings(root, deviceSettingsStore);
    again();
    expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
    expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toBe(before);
  });

  test('main.tsx boot mode follows the same precedence', () => {
    const envelope = JSON.stringify({ version: 1, values: { theme: 'dark' } });
    expect(
      resolveBootTheme(envelope, 'dark', JSON.stringify(ACCOUNT_CACHE)),
    ).toBe('light');
    expect(
      resolveBootTheme(
        envelope,
        null,
        JSON.stringify({ ...ACCOUNT_CACHE, source: 'device' }),
      ),
    ).toBe('dark');
    expect(resolveBootTheme(null, 'light', '{nope')).toBe('light');
  });
});
