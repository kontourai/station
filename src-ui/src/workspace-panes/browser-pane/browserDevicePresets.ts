import type { BrowserViewportView } from '@kontourai/station-contracts/workspace-browser-pane';
import type { WorkspaceBrowserPreviewViewportPreference } from '@kontourai/station-contracts/workspace-browser-preview';

export interface BrowserDevicePreset {
  id: string;
  label: string;
  viewport: BrowserViewportView;
}

/** A few common sizes; the server's viewport route applies them (Emulation). */
export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  {
    id: 'desktop',
    label: 'Desktop 1280 × 800',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  },
  {
    id: 'laptop',
    label: 'Laptop 1440 × 900',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  },
  {
    id: 'tablet',
    label: 'Tablet 820 × 1180',
    viewport: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  },
  {
    id: 'phone',
    label: 'Phone 393 × 852',
    viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  },
  {
    id: 'phone-android',
    label: 'Android phone 412 × 915',
    viewport: {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: true,
    },
  },
];

const VIEWPORT_MIN = 100;
const VIEWPORT_MAX = 4096;

/** A viewport that fills a pane of this CSS size, within the server bounds. */
export function viewportToFill(
  width: number,
  height: number,
): BrowserViewportView | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const clamp = (value: number) =>
    Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
  return { width: clamp(width), height: clamp(height), deviceScaleFactor: 1 };
}

/** The preset a viewport matches, if any. */
export function presetFor(
  viewport: BrowserViewportView,
): BrowserDevicePreset | undefined {
  return BROWSER_DEVICE_PRESETS.find(
    (preset) =>
      preset.viewport.width === viewport.width &&
      preset.viewport.height === viewport.height &&
      preset.viewport.deviceScaleFactor === viewport.deviceScaleFactor &&
      (preset.viewport.mobile === true) === (viewport.mobile === true),
  );
}

/** The v1 pane's viewport preference, as the viewport a migrated session opens with. */
export function viewportForV1Preference(
  preference: WorkspaceBrowserPreviewViewportPreference,
): BrowserViewportView | undefined {
  if (preference === 'desktop') return BROWSER_DEVICE_PRESETS[0]!.viewport;
  if (preference === 'mobile') return BROWSER_DEVICE_PRESETS[3]!.viewport;
  return undefined;
}
