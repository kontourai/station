/**
 * Android's WebView reports `env(safe-area-inset-*)` as 0 for the status and
 * navigation bars even when the activity draws edge-to-edge, so the app
 * renders under the system bars (archive#2617). MainActivity exposes the real
 * WindowInsets through a `StationAndroidInsets` JavascriptInterface and fires
 * `station-android-insets` whenever they change; this module projects them
 * onto the `--safe-*` custom properties that index.css derives from `env`
 * everywhere the platform actually populates it (iOS, desktop PWA).
 */

interface StationAndroidInsetsBridge {
  safeArea(): string;
}

export const ANDROID_INSETS_EVENT = 'station-android-insets';

function readAndroidInsets(
  target: Window,
): Record<string, unknown> | undefined {
  const bridge = target.StationAndroidInsets;
  if (!bridge) return undefined;
  try {
    const value: unknown = JSON.parse(bridge.safeArea());
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Visible bottom in CSS coordinates, measured against the actual native view.
 * An already resized WebView reports its smaller bounds, so callers take the
 * intersection with VisualViewport rather than subtracting IME height twice. */
export function readAndroidVisibleHeight(
  target: Window = window,
): number | undefined {
  const value = readAndroidInsets(target);
  if (!value) return undefined;
  const { viewportWidth, viewportHeight, visibleHeight } = value;
  if (
    [viewportWidth, viewportHeight, visibleHeight].some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 16384,
    )
  )
    return undefined;
  const width = viewportWidth as number;
  const height = viewportHeight as number;
  const visible = visibleHeight as number;
  if (width <= 0 || height <= 0 || visible > height || target.innerWidth <= 0)
    return undefined;
  return (visible * target.innerWidth) / width;
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
      document.documentElement.style.setProperty(cssVar, `${value}px`);
    }
  }
}

export function installAndroidSafeArea(): void {
  if (!window.StationAndroidInsets) return;
  applyAndroidSafeArea();
  window.addEventListener(ANDROID_INSETS_EVENT, applyAndroidSafeArea);
}
