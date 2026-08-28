/**
 * useFeatureSettings — thin hook wrapper over the `featureSettings` device
 * setting (device-settings-store.ts). Kept as its own hook (rather than
 * inlining `useDeviceSettings.featureSettings` at every call site) so its
 * existing consumers (App.tsx, ChatDockBody.tsx, VoiceFeaturesSection.tsx)
 * see no shape change from the pre-unification per-feature localStorage
 * version this replaces.
 */
import {
  DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
  type FeatureSettings,
} from '@kontourai/station-contracts/device-settings';
import { useCallback, useMemo } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';

export type { FeatureSettings };
export type BooleanFeatureSetting = {
  [K in keyof FeatureSettings]: FeatureSettings[K] extends boolean ? K : never;
}[keyof FeatureSettings];

export function useFeatureSettings() {
  const { featureSettings: storedSettings } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const settings = useMemo<FeatureSettings>(
    () => ({
      ...storedSettings,
      notificationSounds: {
        ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
        ...(storedSettings.notificationSounds ?? {}),
      },
    }),
    [storedSettings],
  );

  const update = useCallback(
    (changes: Partial<FeatureSettings>) => {
      setDeviceSetting('featureSettings', { ...settings, ...changes });
    },
    [settings, setDeviceSetting],
  );

  const toggle = useCallback(
    (key: BooleanFeatureSetting) => {
      setDeviceSetting('featureSettings', {
        ...settings,
        [key]: !settings[key],
      });
    },
    [settings, setDeviceSetting],
  );

  return { settings, update, toggle };
}
