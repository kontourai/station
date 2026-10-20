/**
 * The read-only view of the color-theme catalog a picker renders
 * (docs/decisions/user-color-themes.md). This module carries the full
 * catalog, so only Settings (or another lazily loaded surface) should import
 * it; the startup path resolves selections with `color-theme-selection.ts`.
 */

import type { ColorThemeId } from '@kontourai/station-contracts/device-settings';
import { SHIPPED_THEMES } from '@kontourai/ui/contrast';
import {
  COLOR_THEME_FAMILIES,
  type ColorThemeFamily,
  type ColorThemeFlavor,
  type ColorThemeMode,
} from './color-theme-catalog';
import {
  colorThemeFlavorId,
  type ResolvedColorTheme,
} from './color-theme-selection';

/** The catalog flavor a resolved family renders in `mode`. */
export function colorThemeFlavorFor(
  resolved: Exclude<ResolvedColorTheme, { id: 'station' }>,
  mode: ColorThemeMode,
): ColorThemeFlavor {
  const family = COLOR_THEME_FAMILIES.find((f) => f.id === resolved.id)!;
  const id = colorThemeFlavorId(resolved, mode);
  return [family.light, ...family.dark].find((f) => f.id === id)!;
}

/** The colors a picker shows for one flavor with one accent. */
export interface ColorThemeSwatch {
  readonly background: string;
  readonly panel: string;
  readonly text: string;
  readonly accent: string;
}

export interface ColorThemeFlavorOption {
  readonly id: string;
  readonly label: string;
  readonly mode: ColorThemeMode;
  /** With the family's default accent. */
  readonly swatch: ColorThemeSwatch;
}

export interface ColorThemeAccentOption {
  readonly id: string;
  readonly label: string;
  /** The accent's resolved fill in each flavor, keyed by flavor id. */
  readonly swatches: Readonly<Record<string, string>>;
}

export interface ColorThemeOption {
  readonly id: ColorThemeId;
  readonly label: string;
  /** `null` for Station, which has no flavors or named accents. */
  readonly defaultDarkFlavor: string | null;
  readonly defaultAccent: string | null;
  /** Light first, then the dark flavors the setting chooses between. */
  readonly flavors: readonly ColorThemeFlavorOption[];
  readonly accents: readonly ColorThemeAccentOption[];
  /** Default flavor and accent, per mode: the family's thumbnail. */
  readonly preview: Readonly<Record<ColorThemeMode, ColorThemeSwatch>>;
}

function swatch(flavor: ColorThemeFlavor, accent: string): ColorThemeSwatch {
  return {
    background: flavor.roles['--k-bg'],
    panel: flavor.roles['--k-panel'],
    text: flavor.roles['--k-text'],
    accent: flavor.accents[accent].brand,
  };
}

/**
 * `SHIPPED_THEMES` carries the brand slot and its surfaces but not `--k-text`,
 * so the text colour is the installed `tokens.css` value, pinned against that
 * file by `color-themes.test.ts`.
 */
const STATION_TEXT: Readonly<Record<ColorThemeMode, string>> = {
  dark: '#eef3f8',
  light: '#202124',
};

function stationSwatch(mode: ColorThemeMode): ColorThemeSwatch {
  const shipped = SHIPPED_THEMES.default[mode];
  return {
    background: shipped['--k-bg'],
    panel: shipped['--k-panel'],
    text: STATION_TEXT[mode],
    accent: shipped['--k-action'],
  };
}

function familyOption(family: ColorThemeFamily): ColorThemeOption {
  const flavors = [family.light, ...family.dark];
  const defaultDark =
    family.dark.find((f) => f.id === family.defaultDarkFlavor) ??
    family.dark[0]!;
  return {
    id: family.id,
    label: family.label,
    defaultDarkFlavor: defaultDark.id,
    defaultAccent: family.defaultAccent,
    flavors: flavors.map((flavor) => ({
      id: flavor.id,
      label: flavor.label,
      mode: flavor.mode,
      swatch: swatch(flavor, family.defaultAccent),
    })),
    accents: family.accents.map((accent) => ({
      id: accent.id,
      label: accent.label,
      swatches: Object.fromEntries(
        flavors.map((flavor) => [flavor.id, flavor.accents[accent.id].brand]),
      ),
    })),
    preview: {
      light: swatch(family.light, family.defaultAccent),
      dark: swatch(defaultDark, family.defaultAccent),
    },
  };
}

/**
 * Every selectable color theme, Station first: what a picker lists. Set a
 * choice with the device-settings actions (`setDeviceSetting('colorTheme',
 * id)`, `'colorThemeFlavor'` and `'colorThemeAccent'`, `null` for the family
 * default); the applier keeps the document in step.
 */
export const COLOR_THEME_OPTIONS: readonly ColorThemeOption[] = Object.freeze([
  {
    id: 'station',
    label: 'Station',
    defaultDarkFlavor: null,
    defaultAccent: null,
    flavors: [],
    accents: [],
    preview: { light: stationSwatch('light'), dark: stationSwatch('dark') },
  },
  ...COLOR_THEME_FAMILIES.map(familyOption),
]);
