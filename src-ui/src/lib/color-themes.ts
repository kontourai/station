/**
 * Resolving a stored color-theme selection against the catalog, and the
 * read-only view of the catalog a picker renders
 * (docs/decisions/user-color-themes.md).
 *
 * The three settings (`colorTheme`, `colorThemeFlavor`, `colorThemeAccent`)
 * arrive from device storage, Settings import, another tab, and the account
 * server, any of which can be older or newer than this client. So nothing
 * here trusts them: an unknown family resolves to `station` (today's look),
 * an unknown flavor or accent to the family's default. Nothing throws.
 */

import type {
  ColorThemeId,
  DeviceSettings,
} from '@kontourai/station-contracts/device-settings';
import { SHIPPED_THEMES } from '@kontourai/ui/contrast';
import {
  COLOR_THEME_FAMILIES,
  type ColorThemeFamily,
  type ColorThemeFlavor,
  type ColorThemeMode,
} from './color-theme-catalog';

export const DEFAULT_COLOR_THEME: ColorThemeId = 'station';

/** The selection after validation. `station` carries no family. */
export type ResolvedColorTheme =
  | { readonly id: 'station' }
  | {
      readonly id: ColorThemeFamily['id'];
      readonly family: ColorThemeFamily;
      /** The dark flavor in force (light mode always uses `family.light`). */
      readonly darkFlavor: ColorThemeFlavor;
      /** The accent id in force; present in every flavor of the family. */
      readonly accent: string;
    };

export type ColorThemeSettings = Pick<
  DeviceSettings,
  'colorTheme' | 'colorThemeFlavor' | 'colorThemeAccent'
>;

const FAMILY_BY_ID = new Map<string, ColorThemeFamily>(
  COLOR_THEME_FAMILIES.map((family) => [family.id, family]),
);

/**
 * Validate a stored selection. Accepts `unknown` fields on purpose: the
 * values come from storage and the network, not from this client's types.
 */
export function resolveColorThemeSelection(input: {
  readonly colorTheme?: unknown;
  readonly colorThemeFlavor?: unknown;
  readonly colorThemeAccent?: unknown;
}): ResolvedColorTheme {
  const family =
    typeof input.colorTheme === 'string'
      ? FAMILY_BY_ID.get(input.colorTheme)
      : undefined;
  if (!family) return { id: 'station' };
  const darkFlavor =
    family.dark.find((flavor) => flavor.id === input.colorThemeFlavor) ??
    family.dark.find((flavor) => flavor.id === family.defaultDarkFlavor) ??
    family.dark[0];
  const accent = family.accents.some((a) => a.id === input.colorThemeAccent)
    ? (input.colorThemeAccent as string)
    : family.defaultAccent;
  return { id: family.id, family, darkFlavor, accent };
}

/** The flavor a resolved family renders in `mode`. */
export function colorThemeFlavorFor(
  resolved: Exclude<ResolvedColorTheme, { id: 'station' }>,
  mode: ColorThemeMode,
): ColorThemeFlavor {
  return mode === 'light' ? resolved.family.light : resolved.darkFlavor;
}

/** Station's own page canvas per mode, from the installed tokens. */
const STATION_BACKGROUND: Readonly<Record<ColorThemeMode, string>> = {
  dark: SHIPPED_THEMES.default.dark['--k-bg'],
  light: SHIPPED_THEMES.default.light['--k-bg'],
};

/** The effective `--k-bg` for a selection and mode, for `<meta name="theme-color">`. */
export function colorThemeBackground(
  resolved: ResolvedColorTheme,
  mode: ColorThemeMode,
): string {
  if (resolved.id === 'station') return STATION_BACKGROUND[mode];
  return colorThemeFlavorFor(resolved, mode).roles['--k-bg'];
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
  const resolved = resolveColorThemeSelection({ colorTheme: family.id });
  if (resolved.id === 'station') throw new Error('unreachable');
  return {
    id: family.id,
    label: family.label,
    defaultDarkFlavor: resolved.darkFlavor.id,
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
      dark: swatch(resolved.darkFlavor, family.defaultAccent),
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
