import { useSyncExternalStore } from 'react';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import {
  type ResolvedThemeMode,
  resolveThemeMode,
  subscribeSystemThemeMode,
  systemPrefersLight,
} from '../lib/theme-mode';

/**
 * The light/dark mode the page renders now: the saved choice, or the device's
 * when the theme is System (#4407). Re-renders when either changes.
 */
export function useResolvedThemeMode(): ResolvedThemeMode {
  const { theme } = useDeviceSettings();
  const prefersLight = useSyncExternalStore(
    subscribeSystemThemeMode,
    systemPrefersLight,
    () => false,
  );
  return resolveThemeMode(theme, prefersLight);
}
