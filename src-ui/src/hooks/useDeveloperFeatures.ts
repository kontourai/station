import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';

function developerFeatures(
  settings: Pick<
    DeviceSettings,
    | 'developerToolsEnabled'
    | 'experimentalFlowEnabled'
    | 'experimentalReadinessEnabled'
    | 'experimentalTrustEnabled'
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
  };
}

export function useDeveloperFeatures() {
  return developerFeatures(useDeviceSettings());
}

export function developerPaneEnabled(
  descriptor: WorkspacePaneDescriptor,
  features: ReturnType<typeof developerFeatures>,
) {
  if (
    descriptor.id === WORKSPACE_PLAN_PANE_DESCRIPTOR_ID ||
    (descriptor.renderer.kind === 'builtin-component' &&
      descriptor.renderer.name === 'flow-run-console')
  )
    return features.flow;
  if (descriptor.id === WORKSPACE_READINESS_PANE_DESCRIPTOR_ID)
    return features.readiness;
  if (descriptor.id === WORKSPACE_TRUST_PANE_DESCRIPTOR_ID)
    return features.trust;
  return true;
}
