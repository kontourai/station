import { useSyncExternalStore } from 'react';
import { deviceSettingsStore } from '../lib/device-settings-store';

function enabled() {
  return (
    deviceSettingsStore.get('developerToolsEnabled') &&
    deviceSettingsStore.get('experimentalInboxRowActionsEnabled') === true
  );
}

export function useInboxRowActionsPreview() {
  return useSyncExternalStore(deviceSettingsStore.subscribe, enabled, enabled);
}
