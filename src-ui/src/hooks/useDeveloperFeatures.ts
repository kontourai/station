import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { developerFeatures } from './developer-features';

export function useDeveloperFeatures() {
  return developerFeatures(useDeviceSettings());
}

export function developerPaneEnabled(
  descriptor: WorkspacePaneDescriptor,
  // Only the pane previews; the Sheet gestures preview gates no pane.
  features: Pick<
    ReturnType<typeof developerFeatures>,
    'flow' | 'readiness' | 'trust'
  >,
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
