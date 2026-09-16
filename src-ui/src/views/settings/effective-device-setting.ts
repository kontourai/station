/**
 * Epic #2144 slice 2 — the device-scope companion to the server's
 * `settings-effective.ts`: what value a device setting actually has, and
 * whether this device chose it.
 *
 * Only two sources exist here, and that is the whole point of the scope:
 * device settings never round-trip to a server, so nothing but this device
 * and the registry's own declared default can supply a value
 * (docs/design/settings-architecture.md §3 S3).
 *
 * No UI consumer yet — slice 3 renders the badges.
 */

import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';

export type EffectiveDeviceSettingSource = 'default' | 'device';

export interface EffectiveDeviceSetting<K extends keyof DeviceSettings> {
  value: DeviceSettings[K];
  source: EffectiveDeviceSettingSource;
}

const REGISTRY_BY_KEY = new Map(
  DEVICE_SETTINGS_REGISTRY.map((definition) => [
    definition.key as string,
    definition,
  ]),
);

/**
 * Resolves one device setting from the stored envelope's PARTIAL values.
 *
 * Absence in the envelope — not falsiness — is what makes a value the
 * default. `chatDockAutoHide: false`, `projectSidebarCollapsed: false` and
 * `accentColor: null` are all decisions this device made, and every one of
 * them is falsy; a truthiness test would report them as defaults and let a
 * surface tell someone their explicit "off" was never saved.
 *
 * `defaultValue` is REQUIRED on `DeviceSettingDefinition`, so the fallback is
 * always a real declared value rather than `undefined` standing in for one.
 */
export function resolveEffectiveDeviceSetting<K extends keyof DeviceSettings>(
  key: K,
  deviceSettings: Partial<DeviceSettings> | undefined,
): EffectiveDeviceSetting<K> | undefined {
  const definition = REGISTRY_BY_KEY.get(key as string);
  if (!definition) return undefined;
  if (deviceSettings && Object.hasOwn(deviceSettings, key)) {
    const stored = deviceSettings[key];
    // An explicit `undefined` in the envelope is the absence of a value
    // wearing a present key — the store writes deletions, not `undefined`,
    // so this only arises from a hand-edited or imported record.
    if (stored !== undefined) {
      return { value: stored as DeviceSettings[K], source: 'device' };
    }
  }
  return {
    value: definition.defaultValue as DeviceSettings[K],
    source: 'default',
  };
}
