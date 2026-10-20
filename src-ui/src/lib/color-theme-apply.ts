/**
 * Keeps the document's color-theme attributes and `<meta name="theme-color">`
 * in step with the resolved device settings
 * (docs/decisions/user-color-themes.md). `public/startup-theme.js` does the
 * same before the first paint from device storage; this takes over once the
 * app loads, and follows account preferences, Settings, imports and other
 * tabs through the settings store.
 *
 * The stylesheet does the colouring (`color-themes.generated.css`); this only
 * names the selection. `color-scheme` needs nothing here: the tokens set it
 * per mode on the same `data-theme` the mode toggle writes.
 */

import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import {
  colorThemeBackground,
  type ResolvedColorTheme,
  resolveColorThemeSelection,
} from './color-themes';

export const COLOR_THEME_ATTRIBUTE = 'data-color-theme';
export const COLOR_THEME_FLAVOR_ATTRIBUTE = 'data-color-theme-flavor';
export const COLOR_THEME_ACCENT_ATTRIBUTE = 'data-color-theme-accent';

type AppliedSettings = Pick<
  DeviceSettings,
  'theme' | 'colorTheme' | 'colorThemeFlavor' | 'colorThemeAccent'
>;

function setAttribute(root: HTMLElement, name: string, value: string): void {
  if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

/** The single `theme-color` meta in the document head, created if absent. */
function themeColorMeta(doc: Document): HTMLMetaElement {
  const existing = doc.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (existing) return existing;
  const meta = doc.createElement('meta');
  meta.name = 'theme-color';
  doc.head.append(meta);
  return meta;
}

/**
 * Stamp (or, for `station`, clear) the attributes for these settings, and
 * point `theme-color` at the effective page canvas. Returns what applied.
 */
export function applyColorTheme(
  root: HTMLElement,
  settings: AppliedSettings,
): ResolvedColorTheme {
  const resolved = resolveColorThemeSelection(settings);
  if (resolved.id === 'station') {
    root.removeAttribute(COLOR_THEME_ATTRIBUTE);
    root.removeAttribute(COLOR_THEME_FLAVOR_ATTRIBUTE);
    root.removeAttribute(COLOR_THEME_ACCENT_ATTRIBUTE);
  } else {
    setAttribute(root, COLOR_THEME_ATTRIBUTE, resolved.id);
    setAttribute(root, COLOR_THEME_FLAVOR_ATTRIBUTE, resolved.darkFlavor.id);
    setAttribute(root, COLOR_THEME_ACCENT_ATTRIBUTE, resolved.accent);
  }
  const mode = settings.theme === 'light' ? 'light' : 'dark';
  const meta = themeColorMeta(root.ownerDocument);
  const background = colorThemeBackground(resolved, mode);
  if (meta.content !== background) meta.content = background;
  return resolved;
}

interface SettingsSource {
  getSnapshot(): AppliedSettings;
  subscribe(listener: () => void): () => void;
}

/**
 * Apply now and on every settings change, for the page's lifetime. Not a
 * React effect: the app mounts the account boundary only after authority is
 * verified, and the theme has to follow device settings before that too.
 */
export function bindColorThemeToSettings(
  root: HTMLElement,
  source: SettingsSource,
): () => void {
  const apply = () => {
    applyColorTheme(root, source.getSnapshot());
  };
  apply();
  return source.subscribe(apply);
}
