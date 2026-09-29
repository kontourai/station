import { useEffect } from 'react';
import { useBranding } from '../hooks/useBranding';
import {
  applyBrandingTheme,
  BRANDING_THEME_STORAGE_KEY,
  logBrandingThemeViolations,
  resolveBrandingTheme,
} from '../lib/branding-theme';

function writeCache(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(BRANDING_THEME_STORAGE_KEY);
    else localStorage.setItem(BRANDING_THEME_STORAGE_KEY, value);
  } catch {
    // Storage is a boot-time convenience only; the live theme still applies.
  }
}

/**
 * Applies the branding provider's white-label theme to the theme-scope
 * element once `/api/branding` answers, and whenever it changes. `main.tsx`
 * applies the cached copy before the first render; this replaces it with the
 * server's current answer. While the query is loading or has failed, the
 * cached theme stays as it is.
 */
export function BrandingThemeBridge(): null {
  const { theme, loaded } = useBranding();

  useEffect(() => {
    if (!loaded) return;
    const { overrides, violations } = resolveBrandingTheme(theme);
    logBrandingThemeViolations(violations);
    const hasOverrides = Boolean(overrides.dark || overrides.light);
    applyBrandingTheme(
      document.documentElement,
      hasOverrides ? overrides : null,
    );
    // Only the validated result is cached, never the raw provider payload.
    writeCache(hasOverrides ? JSON.stringify(overrides) : null);
  }, [theme, loaded]);

  return null;
}
