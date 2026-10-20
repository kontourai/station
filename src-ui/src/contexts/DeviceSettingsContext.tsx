/**
 * DeviceSettingsContext — the read/write hook split for the device-scope
 * client-settings store (`src-ui/src/lib/device-settings-store.ts`),
 * modeled on `ConfigContext.tsx`'s `useConfig`/`useConfigActions` split.
 * No provider component: like `ConfigContext.tsx`, this reads/writes a
 * module-level store directly rather than threading a React context value.
 */

import { ACCOUNT_PREFERENCE_KEYS } from '@kontourai/station-contracts/account-preferences';
import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { useCallback, useSyncExternalStore } from 'react';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { setHapticsUserEnabled } from '../platform/native/haptics';
import { useAccountPreferences } from './AccountPreferencesContext';

// Keep the fire-and-forget haptic gate in lockstep with the preference
// without requiring every call site to read device settings (archive#1954).
setHapticsUserEnabled(deviceSettingsStore.get('hapticsEnabled'));
deviceSettingsStore.subscribe(() => {
  setHapticsUserEnabled(deviceSettingsStore.get('hapticsEnabled'));
});

/** Resolved device settings (registry defaults folded in). Re-renders on any change. */
export function useDeviceSettings(): DeviceSettings {
  return useSyncExternalStore(
    deviceSettingsStore.subscribe,
    deviceSettingsStore.getSnapshot,
    deviceSettingsStore.getSnapshot,
  );
}

/** True once the store has resolved storage — synchronous in this environment. */
export function useDeviceSettingsHydrated(): boolean {
  return useSyncExternalStore(
    deviceSettingsStore.subscribe,
    deviceSettingsStore.isHydrated,
    deviceSettingsStore.isHydrated,
  );
}

export interface DeviceSettingsActions {
  setDeviceSetting: <K extends keyof DeviceSettings>(
    key: K,
    value: DeviceSettings[K],
  ) => void;
  /**
   * Several keys as ONE choice: one envelope write and, when signed in, one
   * account patch. For values that only make sense together (a color theme
   * and its flavor and accent), so no subscriber sees half of the change and
   * an account server cannot accept one key of it and refuse another.
   */
  setDeviceSettings: (values: Partial<DeviceSettings>) => void;
  resetDeviceSetting: <K extends keyof DeviceSettings>(key: K) => void;
  /** One envelope write and one notify for the whole set (#2144 slice 6). */
  resetDeviceSettings: (keys: readonly (keyof DeviceSettings)[]) => void;
}

export function useDeviceSettingsActions(): DeviceSettingsActions {
  const account = useAccountPreferences();
  const setDeviceSetting = useCallback(
    <K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]) => {
      deviceSettingsStore.set(key, value);
    },
    [],
  );
  const setDeviceSettings = useCallback((values: Partial<DeviceSettings>) => {
    deviceSettingsStore.merge(values);
  }, []);
  const resetDeviceSetting = useCallback(
    <K extends keyof DeviceSettings>(key: K) => {
      deviceSettingsStore.reset(key);
    },
    [],
  );

  const resetDeviceSettings = useCallback(
    (keys: readonly (keyof DeviceSettings)[]) => {
      deviceSettingsStore.resetMany(
        account.status === 'account'
          ? keys.filter(
              (key) =>
                !ACCOUNT_PREFERENCE_KEYS.some((candidate) => candidate === key),
            )
          : keys,
      );
    },
    [account.status],
  );

  return {
    setDeviceSetting,
    setDeviceSettings,
    resetDeviceSetting,
    resetDeviceSettings,
  };
}
