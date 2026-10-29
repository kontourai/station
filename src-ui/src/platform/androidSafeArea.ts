/**
 * Android's WebView reports `env(safe-area-inset-*)` as 0 for the status and
 * navigation bars even when the activity draws edge-to-edge, so the app
 * renders under the system bars (archive#2617). MainActivity exposes the real
 * WindowInsets through a `StationAndroidInsets` JavascriptInterface and fires
 * `station-android-insets` whenever they change; this module projects them
 * onto the `--safe-*` custom properties that index.css derives from `env`
 * everywhere the platform actually populates it (iOS, desktop PWA).
 */

import {
  ANDROID_INSETS_EVENT,
  readAndroidInsets,
} from '@kontourai/station-shared/visual-viewport';

interface StationAndroidInsetsBridge {
  safeArea(): string;
  networkCost?(): string;
}

declare global {
  interface Window {
    StationAndroidInsets?: StationAndroidInsetsBridge;
  }
}

const VAR_BY_SIDE = {
  top: '--safe-top',
  right: '--safe-right',
  bottom: '--safe-bottom',
  left: '--safe-left',
} as const;

function applyAndroidSafeArea(): void {
  const insets = readAndroidInsets(window);
  if (!insets) return;
  for (const [side, cssVar] of Object.entries(VAR_BY_SIDE)) {
    const value = insets[side];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      const style = document.documentElement.style;
      const next = `${value}px`;
      if (style.getPropertyValue(cssVar) !== next)
        style.setProperty(cssVar, next);
    }
  }
}

export function installAndroidSafeArea(): void {
  if (!window.StationAndroidInsets) return;
  applyAndroidSafeArea();
  let frame: number | undefined;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      applyAndroidSafeArea();
    });
  };
  window.addEventListener(ANDROID_INSETS_EVENT, schedule);
}
