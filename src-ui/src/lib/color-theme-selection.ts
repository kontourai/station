/**
 * Resolving a stored color-theme selection (docs/decisions/user-color-themes.md)
 * against the small generated index, not the full catalog, so the app's
 * startup path carries a few hundred bytes of theme data rather than every
 * palette. The index is rendered from `color-theme-catalog.ts` by
 * `npm run gen:color-themes`, and the drift test holds them together.
 *
 * The three settings (`colorTheme`, `colorThemeFlavor`, `colorThemeAccent`)
 * arrive from device storage, Settings import, another tab, the account
 * server and the last-applied appearance cache, any of which can be older or
 * newer than this client. So nothing here trusts them: an unknown family
 * resolves to `station` (today's look), an unknown flavor or accent to the
 * family's default. Nothing throws.
 */

import type { ColorThemeId } from '@kontourai/station-contracts/device-settings';
import index from './color-theme-index.generated.json';

export type ColorThemeMode = 'dark' | 'light';

interface IndexedFamily {
  readonly stylesheet: string;
  readonly light: { readonly id: string; readonly background: string };
  readonly dark: readonly {
    readonly id: string;
    readonly background: string;
  }[];
  readonly defaultDarkFlavor: string;
  readonly accents: readonly string[];
  readonly defaultAccent: string;
}

const FAMILIES = new Map<string, IndexedFamily>(
  Object.entries(index.families as Record<string, IndexedFamily>),
);

/** The selection after validation. `station` carries no family. */
export type ResolvedColorTheme =
  | { readonly id: 'station' }
  | {
      readonly id: Exclude<ColorThemeId, 'station'>;
      /** The dark flavor in force; light mode always uses the family's light one. */
      readonly darkFlavor: string;
      /** The accent id in force; present in every flavor of the family. */
      readonly accent: string;
    };

/**
 * Validate a stored selection. Accepts `unknown` fields on purpose: the
 * values come from storage and the network, not from this client's types.
 */
export function resolveColorThemeSelection(input: {
  readonly colorTheme?: unknown;
  readonly colorThemeFlavor?: unknown;
  readonly colorThemeAccent?: unknown;
}): ResolvedColorTheme {
  const id = typeof input.colorTheme === 'string' ? input.colorTheme : '';
  const family = Object.hasOwn(index.families, id)
    ? FAMILIES.get(id)
    : undefined;
  if (!family) return { id: 'station' };
  const darkFlavor = family.dark.some((f) => f.id === input.colorThemeFlavor)
    ? (input.colorThemeFlavor as string)
    : family.defaultDarkFlavor;
  const accent = family.accents.includes(input.colorThemeAccent as string)
    ? (input.colorThemeAccent as string)
    : family.defaultAccent;
  return {
    id: id as Exclude<ColorThemeId, 'station'>,
    darkFlavor,
    accent,
  };
}

/** The flavor id a resolved family renders in `mode`. */
export function colorThemeFlavorId(
  resolved: Exclude<ResolvedColorTheme, { id: 'station' }>,
  mode: ColorThemeMode,
): string {
  return mode === 'light'
    ? FAMILIES.get(resolved.id)!.light.id
    : resolved.darkFlavor;
}

/** A named theme's page canvas in `mode`, for `<meta name="theme-color">`. */
export function colorThemeBackground(
  resolved: Exclude<ResolvedColorTheme, { id: 'station' }>,
  mode: ColorThemeMode,
): string {
  const family = FAMILIES.get(resolved.id)!;
  return mode === 'light'
    ? family.light.background
    : family.dark.find((f) => f.id === resolved.darkFlavor)!.background;
}

/** The URL of a family's stylesheet, with its content digest. */
export function colorThemeStylesheet(
  resolved: Exclude<ResolvedColorTheme, { id: 'station' }>,
): string {
  return FAMILIES.get(resolved.id)!.stylesheet;
}
