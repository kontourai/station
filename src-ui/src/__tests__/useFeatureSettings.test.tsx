/** @vitest-environment jsdom */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const setDeviceSetting = vi.hoisted(() => vi.fn());
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    featureSettings: {
      voiceS2SEnabled: false,
      mobilePairingEnabled: false,
      ttsReadbackEnabled: false,
      pushNotificationsEnabled: false,
    },
  }),
  useDeviceSettingsActions: () => ({ setDeviceSetting }),
}));

import { useFeatureSettings } from '../hooks/useFeatureSettings';

describe('useFeatureSettings', () => {
  test('upgrades a legacy feature-settings projection with sound defaults before read or write', () => {
    const { result } = renderHook(() => useFeatureSettings());
    expect(result.current.settings.notificationSounds).toEqual(
      DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    );

    act(() => result.current.update({ voiceS2SEnabled: true }));
    expect(setDeviceSetting).toHaveBeenCalledWith('featureSettings', {
      voiceS2SEnabled: true,
      mobilePairingEnabled: false,
      ttsReadbackEnabled: false,
      pushNotificationsEnabled: false,
      notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    });
  });
});
