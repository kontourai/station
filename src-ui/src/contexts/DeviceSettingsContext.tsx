/**
 * DeviceSettingsContext — the read/write hook split for the device-scope
 * client-settings store (`src-ui/src/lib/device-settings-store.ts`),
 * modeled on `ConfigContext.tsx`'s `useConfig`/`useConfigActions` split.
 * No provider component: like `ConfigContext.tsx`, this reads/writes a
 * module-level store directly rather than threading a React context value.
 */

import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { useCallback, useSyncExternalStore } from 'react';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { setHapticsUserEnabled } from '../platform/native/haptics';

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
  resetDeviceSetting: <K extends keyof DeviceSettings>(key: K) => void;
}

export function useDeviceSettingsActions(): DeviceSettingsActions {
  const setDeviceSetting = useCallback(
    <K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]) => {
      deviceSettingsStore.set(key, value);
    },
    [],
  );
  const resetDeviceSetting = useCallback(
    <K extends keyof DeviceSettings>(key: K) => {
      deviceSettingsStore.reset(key);
    },
    [],
  );

  return { setDeviceSetting, resetDeviceSetting };
}
