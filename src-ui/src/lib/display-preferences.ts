/**
 * Density and motion choices on the document root (#4692).
 *
 * `data-density` carries `comfortable` or `compact`; tokens.css keys the text
 * scale on it, with Comfortable also the default when the attribute is absent.
 * `data-motion="reduce"` collapses motion as the device's
 * `prefers-reduced-motion: reduce` does; `system` sets nothing, so the device
 * decides.
 *
 * Mirrored, without imports, in `public/startup-theme.js`, which stamps both
 * before first paint. `bindColorThemeToSettings` (lib/color-theme-apply.ts)
 * keeps them following the settings store for the page's lifetime.
 */
import type {
  DensityPreference,
  MotionPreference,
} from '@kontourai/station-contracts/device-settings';

export const DENSITY_ATTRIBUTE = 'data-density';
export const MOTION_ATTRIBUTE = 'data-motion';

/** Anything but an explicit `compact` (including a newer client's value) is Comfortable. */
export function resolveDensity(value: unknown): DensityPreference {
  return value === 'compact' ? 'compact' : 'comfortable';
}

/** Anything but an explicit `reduce` follows the device. */
export function resolveMotion(value: unknown): MotionPreference {
  return value === 'reduce' ? 'reduce' : 'system';
}

export function applyDensity(root: HTMLElement, value: unknown): void {
  const density = resolveDensity(value);
  if (root.getAttribute(DENSITY_ATTRIBUTE) !== density)
    root.setAttribute(DENSITY_ATTRIBUTE, density);
}

export function applyMotion(root: HTMLElement, value: unknown): void {
  if (resolveMotion(value) === 'reduce') {
    if (root.getAttribute(MOTION_ATTRIBUTE) !== 'reduce')
      root.setAttribute(MOTION_ATTRIBUTE, 'reduce');
  } else if (root.hasAttribute(MOTION_ATTRIBUTE)) {
    root.removeAttribute(MOTION_ATTRIBUTE);
  }
}
