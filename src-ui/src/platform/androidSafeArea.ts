/**
 * Android's WebView reports `env(safe-area-inset-*)` as 0 for the status and
 * navigation bars even when the activity draws edge-to-edge, so the app
 * renders under the system bars (station#2617). MainActivity exposes the real
 * WindowInsets through a `StationAndroidInsets` JavascriptInterface and fires
 * `station-android-insets` whenever they change; this module projects them
 * onto the `--safe-*` custom properties that index.css derives from `env()`
 * everywhere the platform actually populates it (iOS, desktop PWA).
 */

interface StationAndroidInsetsBridge {
  safeArea(): string;
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
  const bridge = window.StationAndroidInsets;
  if (!bridge) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bridge.safeArea());
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const insets = parsed as Record<string, unknown>;
  for (const [side, cssVar] of Object.entries(VAR_BY_SIDE)) {
    const value = insets[side];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      document.documentElement.style.setProperty(cssVar, `${value}px`);
    }
  }
}

export function installAndroidSafeArea(): void {
  if (!window.StationAndroidInsets) return;
  applyAndroidSafeArea();
  window.addEventListener('station-android-insets', applyAndroidSafeArea);
}
