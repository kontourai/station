/**
 * The light/dark mode the page renders, from the person's theme preference
 * (#4407). `system`, the default, follows the device's
 * `prefers-color-scheme`; `light` and `dark` are explicit choices.
 *
 * `data-theme` on `<html>` only ever carries the resolved `light` or `dark`:
 * every stylesheet and token reader keys on those two values.
 *
 * Mirrored, without imports, in `public/startup-theme.js`, which paints the
 * same mode before any module loads.
 */
import type { ThemePreference } from '@kontourai/station-contracts/device-settings';

export type ResolvedThemeMode = 'light' | 'dark';

export const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)';

function systemQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
      ? window.matchMedia(SYSTEM_LIGHT_QUERY)
      : null;
  } catch {
    return null;
  }
}

/** Whether the device asks for light. Dark when it cannot say, as before. */
export function systemPrefersLight(): boolean {
  return systemQuery()?.matches === true;
}

/**
 * The mode for a preference. Anything that is not an explicit light or dark
 * (`system`, or a value from a newer client) follows the device.
 */
export function resolveThemeMode(
  preference: ThemePreference | string | null | undefined,
  prefersLight: boolean = systemPrefersLight(),
): ResolvedThemeMode {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersLight ? 'light' : 'dark';
}

/** Calls `onChange` when the device's light/dark preference changes. */
export function subscribeSystemThemeMode(onChange: () => void): () => void {
  const query = systemQuery();
  if (!query) return () => {};
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  // Safari before 14 only has the deprecated listener API.
  query.addListener?.(onChange);
  return () => query.removeListener?.(onChange);
}

/** Write the resolved mode for `preference` onto the root. */
export function applyThemeMode(
  root: HTMLElement,
  preference: ThemePreference | string | null | undefined,
): ResolvedThemeMode {
  const mode = resolveThemeMode(preference);
  if (root.getAttribute('data-theme') !== mode)
    root.setAttribute('data-theme', mode);
  return mode;
}
