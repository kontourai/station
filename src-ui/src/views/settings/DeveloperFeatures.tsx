import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { Toggle } from '../../components/Toggle';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';

const FEATURES = [
  ['experimentalFlowEnabled', 'experimental-flow'],
  ['experimentalReadinessEnabled', 'experimental-readiness'],
  ['experimentalTrustEnabled', 'experimental-trust'],
] as const;

export function DeveloperFeatures() {
  const settings = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  if (!settings.developerToolsEnabled) return null;
  return (
    <>
      <p className="settings__field-hint">
        Experimental project tools · off by default, saved on this device.
      </p>
      {FEATURES.map(([key, id]) => {
        const definition = DEVICE_SETTINGS_REGISTRY.find(
          (entry) => entry.key === key,
        )!;
        return (
          <SettingsPageRow
            key={key}
            {...settingsRow(id)}
            description={definition.description}
            control={
              <Toggle
                label={definition.label}
                checked={settings[key] === true}
                onChange={(enabled) => setDeviceSetting(key, enabled)}
              />
            }
          />
        );
      })}
    </>
  );
}
