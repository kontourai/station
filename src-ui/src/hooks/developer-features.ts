import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';

/**
 * Which developer previews are on for this device: each needs Developer tools
 * and its own switch. The one statement of that rule, kept free of
 * `DeviceSettingsContext` (whose module load arms haptics) so the shared
 * dialog surface can read it straight from the device-settings store.
 */
export function developerFeatures(
  settings: Pick<
    DeviceSettings,
    | 'developerToolsEnabled'
    | 'experimentalFlowEnabled'
    | 'experimentalReadinessEnabled'
    | 'experimentalTrustEnabled'
    | 'experimentalSheetGesturesEnabled'
  >,
) {
  return {
    flow:
      settings.developerToolsEnabled &&
      settings.experimentalFlowEnabled === true,
    readiness:
      settings.developerToolsEnabled &&
      settings.experimentalReadinessEnabled === true,
    trust:
      settings.developerToolsEnabled &&
      settings.experimentalTrustEnabled === true,
    sheetGestures:
      settings.developerToolsEnabled &&
      settings.experimentalSheetGesturesEnabled === true,
  };
}
