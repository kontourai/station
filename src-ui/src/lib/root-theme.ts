/**
 * One observer for "the colours the root resolves to may have changed".
 *
 * Most of the UI reads colour through CSS custom properties and follows the
 * cascade for free. A few consumers cannot: xterm paints a canvas, MCP App
 * and HTML-reply frames receive resolved token values over postMessage. Those
 * have to re-read the tokens whenever anything that feeds the cascade on
 * `<html>` changes:
 *
 * - `data-theme` (light/dark), written by ThemeToggle and AccountPreferences;
 * - `data-color-theme`, `data-color-theme-flavor`, `data-color-theme-accent`
 *   (palette themes);
 * - `data-app-channel`, `data-brand-focus` and `class` (channel retints, the
 *   white-label focus marker, the dev-build class);
 * - inline `style`, where white-label branding (`lib/branding-theme.ts`) and
 *   the device accent (`lib/accent-contrast.ts`) write their overrides.
 *
 * Inline style on `<html>` also carries geometry that changes far more often
 * than colour (the visual-viewport inset while a keyboard animates, region
 * clearances, safe-area insets). Those are bare lengths, and no colour is a
 * bare length, so the signature skips them: a keyboard animation does not
 * re-theme the terminal on every frame.
 */
import { useSyncExternalStore } from 'react';

/** The attributes on `<html>` whose value can change resolved colours. */
const ROOT_THEME_ATTRIBUTES = [
  'data-theme',
  'data-color-theme',
  'data-color-theme-flavor',
  'data-color-theme-accent',
  'data-app-channel',
  'data-brand-focus',
  'class',
  'style',
] as const;

// Exponents included: the visual-viewport inset is written straight from a
// float and can read `1.1368683772161603e-13px` mid keyboard animation.
const BARE_LENGTH = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(px)?$/;

/**
 * A string that changes whenever the root's theme inputs change, and stays
 * the same across geometry-only inline style writes.
 */
function rootThemeSignature(root: HTMLElement): string {
  const parts: string[] = [];
  for (const name of ROOT_THEME_ATTRIBUTES) {
    if (name === 'style') continue;
    parts.push(`${name}=${root.getAttribute(name) ?? ''}`);
  }
  const style = root.style;
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    const value = style.getPropertyValue(property).trim();
    if (BARE_LENGTH.test(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  declarations.sort();
  parts.push(`style=${declarations.join(';')}`);
  return parts.join('|');
}

interface RootWatch {
  observer: MutationObserver;
  listeners: Set<() => void>;
  signature: string;
}

/** Bumped once per observed theme change, whichever root it was on. */
let themeVersion = 0;

const watches = new WeakMap<HTMLElement, RootWatch>();

function defaultRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Calls `onChange` after any change to the root's theme inputs (see the
 * module comment). One MutationObserver is shared per root however many
 * consumers subscribe. Returns the unsubscribe function.
 */
export function observeRootTheme(
  onChange: () => void,
  root: HTMLElement | null = defaultRoot(),
): () => void {
  if (!root || typeof MutationObserver === 'undefined') return () => {};
  let watch = watches.get(root);
  if (!watch) {
    const created: RootWatch = {
      observer: new MutationObserver(() => {
        const next = rootThemeSignature(root);
        if (next === created.signature) return;
        created.signature = next;
        themeVersion += 1;
        for (const listener of [...created.listeners]) listener();
      }),
      listeners: new Set(),
      signature: rootThemeSignature(root),
    };
    created.observer.observe(root, {
      attributes: true,
      attributeFilter: [...ROOT_THEME_ATTRIBUTES],
    });
    watches.set(root, created);
    watch = created;
  }
  const active = watch;
  active.listeners.add(onChange);
  return () => {
    active.listeners.delete(onChange);
    if (active.listeners.size === 0) {
      active.observer.disconnect();
      watches.delete(root);
    }
  };
}

function subscribe(onStoreChange: () => void): () => void {
  return observeRootTheme(onStoreChange);
}

function getSnapshot(): number {
  return themeVersion;
}

/**
 * A number that increases whenever the document root's theme inputs change.
 * Put it in an effect's dependencies to re-read resolved tokens (computed
 * styles) after a light/dark flip, palette, accent or branding change.
 */
export function useRootThemeVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
