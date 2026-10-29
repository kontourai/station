/**
 * The last appearance this device rendered: mode and color theme, and whether
 * it came from the signed-in person's account or from this device's own
 * settings (docs/decisions/user-color-themes.md).
 *
 * Account preferences never enter the device-settings envelope, so before
 * this cache a signed-in person's appearance could not be in force before
 * first paint: the startup script only had device values. This is a cache of
 * what was rendered, written by the color-theme applier on every apply, not a
 * copy of account values into device settings; nothing edits it and it
 * decides nothing once the account answers.
 *
 * Precedence, the same in `public/startup-theme.js`, `resolveBootTheme` and
 * the settings store's boot snapshot:
 *
 * 1. A cache whose source is `account` wins until this page knows whose
 *    appearance applies: the account's values arrive, the account boundary
 *    reports there is no person, or the device's own appearance is changed.
 * 2. Otherwise the device settings envelope (then the legacy `theme` key),
 *    exactly as before. A `device` cache is never read: the envelope it
 *    mirrors is the authority.
 */

import {
  COLOR_THEME_ID_PATTERN,
  type DeviceSettings,
} from '@kontourai/station-contracts/device-settings';

export const APPEARANCE_CACHE_KEY = 'station-appearance-v1';

export const APPEARANCE_KEYS = [
  'theme',
  'colorTheme',
  'colorThemeFlavor',
  'colorThemeAccent',
] as const satisfies readonly (keyof DeviceSettings)[];

export type AppearanceSource = 'account' | 'device';

export type Appearance = Pick<DeviceSettings, (typeof APPEARANCE_KEYS)[number]>;

export interface AppearanceCache extends Appearance {
  readonly version: 1;
  readonly source: AppearanceSource;
}

const ID = new RegExp(COLOR_THEME_ID_PATTERN);
const id = (value: unknown) => typeof value === 'string' && ID.test(value);
const optionalId = (value: unknown) => value === null || id(value);

/** Parse a stored cache; anything malformed is no cache at all. */
export function parseAppearanceCache(
  raw: string | null,
): AppearanceCache | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      value?.version !== 1 ||
      (value.source !== 'account' && value.source !== 'device') ||
      (value.theme !== 'light' && value.theme !== 'dark') ||
      !id(value.colorTheme) ||
      !optionalId(value.colorThemeFlavor) ||
      !optionalId(value.colorThemeAccent)
    )
      return null;
    return {
      version: 1,
      source: value.source,
      theme: value.theme,
      colorTheme: value.colorTheme as DeviceSettings['colorTheme'],
      colorThemeFlavor: value.colorThemeFlavor as string | null,
      colorThemeAccent: value.colorThemeAccent as string | null,
    };
  } catch {
    return null;
  }
}

/** The cached appearance that takes precedence at boot, if any. */
export function bootAppearanceFrom(raw: string | null): Appearance | null {
  const cache = parseAppearanceCache(raw);
  return cache?.source === 'account' ? cache : null;
}

export function readAppearanceCache(): string | null {
  try {
    return localStorage.getItem(APPEARANCE_CACHE_KEY);
  } catch {
    return null;
  }
}

/** Record what was just rendered; skipped when nothing changed. */
export function writeAppearanceCache(
  appearance: Appearance,
  source: AppearanceSource,
): void {
  const next = JSON.stringify({
    version: 1,
    source,
    theme: appearance.theme,
    colorTheme: appearance.colorTheme,
    colorThemeFlavor: appearance.colorThemeFlavor,
    colorThemeAccent: appearance.colorThemeAccent,
  });
  try {
    if (localStorage.getItem(APPEARANCE_CACHE_KEY) !== next)
      localStorage.setItem(APPEARANCE_CACHE_KEY, next);
  } catch {
    // Without storage the next launch simply paints from device settings.
  }
}
