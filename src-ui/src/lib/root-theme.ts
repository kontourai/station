/**
 * One observer for "the colours the root resolves to may have changed".
 *
 * Most of the UI reads colour through CSS custom properties and follows the
 * cascade for free. A few consumers cannot: MCP App and HTML-reply frames
 * receive resolved token values over postMessage (the SDK terminal view, which
 * paints a canvas, watches the same attributes itself). Those have to re-read the tokens whenever anything that feeds the cascade on
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
 * clearances, safe-area insets). The SDK's `rootThemeSignature` skips those
 * bare lengths, so a keyboard animation re-themes nothing; this module and
 * the terminal view share that one signature.
 */
import {
  ROOT_THEME_ATTRIBUTES,
  rootThemeSignature,
} from '@kontourai/station-sdk';
import { useSyncExternalStore } from 'react';

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
