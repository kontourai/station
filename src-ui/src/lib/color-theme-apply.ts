/**
 * Keeps the document's color-theme attributes and `<meta name="theme-color">`
 * in step with the resolved device settings
 * (docs/decisions/user-color-themes.md). `public/startup-theme.js` does the
 * same before the first paint from device storage; this takes over once the
 * app loads, and follows account preferences, Settings, imports and other
 * tabs through the settings store.
 *
 * Each family's stylesheet (`public/color-themes/<family>.css`) does the
 * colouring; this loads the selected one and names the selection. On a
 * switch to another family the attributes change only once its sheet has
 * settled, so the page never shows the new attributes over missing rules.
 * `color-scheme` needs nothing here: the tokens set it per mode on the same
 * `data-theme` the mode toggle writes.
 */

import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { writeAppearanceCache } from './appearance-cache';
import {
  colorThemeBackground,
  colorThemeStylesheet,
  type ResolvedColorTheme,
  resolveColorThemeSelection,
} from './color-theme-selection';

export const COLOR_THEME_ATTRIBUTE = 'data-color-theme';
export const COLOR_THEME_FLAVOR_ATTRIBUTE = 'data-color-theme-flavor';
export const COLOR_THEME_ACCENT_ATTRIBUTE = 'data-color-theme-accent';

type AppliedSettings = Pick<
  DeviceSettings,
  'theme' | 'colorTheme' | 'colorThemeFlavor' | 'colorThemeAccent'
>;

/** The selected family's sheet; `startup-theme.js` inserts it under this id. */
export const COLOR_THEME_STYLESHEET_ID = 'station-color-theme';

function setAttribute(root: HTMLElement, name: string, value: string): void {
  if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

/** Marks the `theme-color` meta this module owns, so it removes only its own. */
const OWNED_META = 'data-color-theme-meta';

/**
 * Point `theme-color` at a named theme's page canvas, or, for Station, remove
 * the one a theme added: a default page carries no theme-color, as before
 * color themes existed. The startup script's meta counts as ours.
 */
function syncThemeColor(doc: Document, background: string | null): void {
  let meta = doc.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (background === null) {
    if (meta?.hasAttribute(OWNED_META)) meta.remove();
    return;
  }
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    meta.setAttribute(OWNED_META, '');
    doc.head.append(meta);
  }
  if (meta.content !== background) meta.content = background;
}

function stamp(
  root: HTMLElement,
  resolved: ResolvedColorTheme,
  mode: 'dark' | 'light',
): void {
  if (resolved.id === 'station') {
    root.removeAttribute(COLOR_THEME_ATTRIBUTE);
    root.removeAttribute(COLOR_THEME_FLAVOR_ATTRIBUTE);
    root.removeAttribute(COLOR_THEME_ACCENT_ATTRIBUTE);
  } else {
    setAttribute(root, COLOR_THEME_ATTRIBUTE, resolved.id);
    setAttribute(root, COLOR_THEME_FLAVOR_ATTRIBUTE, resolved.darkFlavor);
    setAttribute(root, COLOR_THEME_ACCENT_ATTRIBUTE, resolved.accent);
  }
  syncThemeColor(
    root.ownerDocument,
    resolved.id === 'station' ? null : colorThemeBackground(resolved, mode),
  );
}

function activeSheet(doc: Document): HTMLLinkElement | null {
  const element = doc.getElementById(COLOR_THEME_STYLESHEET_ID);
  return element instanceof doc.defaultView!.HTMLLinkElement ? element : null;
}

/** A family sheet requested by a live switch, not yet settled. */
const pendingSheets = new WeakMap<Document, HTMLLinkElement>();
/** The latest settings per root, applied when a pending sheet settles. */
const latestSettings = new WeakMap<HTMLElement, AppliedSettings>();

function dropPending(doc: Document): void {
  pendingSheets.get(doc)?.remove();
  pendingSheets.delete(doc);
}

function requestSheet(root: HTMLElement, href: string): void {
  const doc = root.ownerDocument;
  if (pendingSheets.get(doc)?.getAttribute('href') === href) return;
  dropPending(doc);
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  const settle = (state: 'loaded' | 'failed') => {
    link.dataset.state = state;
    if (pendingSheets.get(doc) !== link) return;
    pendingSheets.delete(doc);
    activeSheet(doc)?.remove();
    link.id = COLOR_THEME_STYLESHEET_ID;
    // A sheet that failed still hands over: the attributes then select no
    // rules and Station's own colours show, rather than a half-applied theme.
    const settings = latestSettings.get(root);
    if (settings) applyColorTheme(root, settings);
  };
  link.addEventListener('load', () => settle('loaded'), { once: true });
  link.addEventListener('error', () => settle('failed'), { once: true });
  pendingSheets.set(doc, link);
  doc.head.append(link);
}

/**
 * Stamp (or, for `station`, clear) the attributes for these settings, load
 * the family's sheet, and keep `theme-color` on a named theme's page canvas.
 * Returns what this call applied: a family whose sheet is still loading
 * leaves the previous selection in force until it settles.
 */
export function applyColorTheme(
  root: HTMLElement,
  settings: AppliedSettings,
): ResolvedColorTheme {
  const doc = root.ownerDocument;
  const resolved = resolveColorThemeSelection(settings);
  const mode = settings.theme === 'light' ? 'light' : 'dark';
  latestSettings.set(root, settings);
  if (resolved.id === 'station') {
    dropPending(doc);
    activeSheet(doc)?.remove();
    stamp(root, resolved, mode);
    return resolved;
  }
  const href = colorThemeStylesheet(resolved);
  if (activeSheet(doc)?.getAttribute('href') !== href) {
    requestSheet(root, href);
    return resolveColorThemeSelection({
      colorTheme: root.getAttribute(COLOR_THEME_ATTRIBUTE),
      colorThemeFlavor: root.getAttribute(COLOR_THEME_FLAVOR_ATTRIBUTE),
      colorThemeAccent: root.getAttribute(COLOR_THEME_ACCENT_ATTRIBUTE),
    });
  }
  dropPending(doc);
  stamp(root, resolved, mode);
  return resolved;
}

/**
 * A promise that settles once the selected family's sheet has loaded or
 * failed, and after `timeoutMs` at the latest; `null` when nothing is
 * loading (no theme, or the sheet already settled). main.tsx waits on it
 * before the first render, so a themed person never sees the app in
 * Station's colours between the splash and the sheet, and renders
 * synchronously, exactly as before, otherwise.
 */
export function whenColorThemeStylesheetSettled(
  doc: Document,
  timeoutMs = 3000,
): Promise<void> | null {
  const link = activeSheet(doc);
  if (!link || link.dataset.state || link.sheet) return null;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
  });
}

interface SettingsSource {
  getSnapshot(): AppliedSettings;
  subscribe(listener: () => void): () => void;
  /** Where the snapshot's appearance comes from (the settings store's answer). */
  getAppearanceSource?(): 'account' | 'device' | 'cache';
}

/**
 * Apply now and on every settings change, for the page's lifetime, and record
 * what was rendered in the appearance cache (lib/appearance-cache.ts) so the
 * next launch can paint it before first paint. A snapshot that is itself the
 * cache is not written back. Not a React effect: the app mounts the account
 * boundary only after authority is verified, and the theme has to follow
 * device settings before that too.
 */
export function bindColorThemeToSettings(
  root: HTMLElement,
  source: SettingsSource,
): () => void {
  const apply = () => {
    const settings = source.getSnapshot();
    applyColorTheme(root, settings);
    const from = source.getAppearanceSource?.() ?? 'device';
    if (from !== 'cache') writeAppearanceCache(settings, from);
  };
  apply();
  return source.subscribe(apply);
}
