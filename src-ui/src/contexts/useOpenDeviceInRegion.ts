import { WORKSPACE_DEVICE_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-device-pane';
import { useCallback } from 'react';
import {
  type DevicePaneSelection,
  selectDeviceInPane,
} from '../workspace-panes/device/devicePaneSelection';
import {
  clearDevicePaneState,
  devicePaneStorage,
  readDevicePaneState,
  writeDevicePaneState,
} from '../workspace-panes/devicePaneStateStorage';
import {
  type OpenInRegionOptions,
  type OpenInRegionOutcome,
  useRegionModelOptional,
} from './RegionModelContext';
import { type OpenSurfaceInRegionModel, openInRegion } from './useOpenInRegion';

/*
 * Its own module (review F): `useOpenInRegion` is imported eagerly (the pane
 * registry, the region chooser, chat links), and this opener pulls the
 * Device pane's selection storage and descriptor with it. Only the lazy
 * float and Device paths import this file, so none of it rides the entry.
 */

/**
 * Open the Device pane on one device as a dock pane (#90 D9) — the
 * float-over-chat's "Open in right panel" for a Device source.
 *
 * The Device pane is one occurrence whose SELECTED device is its stored
 * state, so this writes the selection (restoring the previous one on a
 * refusal), reveals the pane, and tells an already-mounted pane to switch;
 * a pane that mounts now reads the stored selection and rejoins the session.
 */
export function openDeviceInRegion(
  model: OpenSurfaceInRegionModel,
  scope: { apiBase: string; authorityKey: string },
  device: DevicePaneSelection,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome {
  const storage = devicePaneStorage();
  const previous = readDevicePaneState(storage, scope);
  writeDevicePaneState(storage, scope, device);
  const outcome = openInRegion(model, WORKSPACE_DEVICE_PANE_INSTANCE, options);
  if (!outcome.ok) {
    if (previous) writeDevicePaneState(storage, scope, previous);
    else clearDevicePaneState(storage, scope);
    return outcome;
  }
  selectDeviceInPane(device);
  return outcome;
}

/** `openDeviceInRegion` bound to the mounted region model, or null where there is none. */
export function useOpenDeviceInRegion():
  | ((
      scope: { apiBase: string; authorityKey: string },
      device: DevicePaneSelection,
      options?: OpenInRegionOptions,
    ) => OpenInRegionOutcome)
  | null {
  const model = useRegionModelOptional();
  const open = useCallback(
    (
      scope: { apiBase: string; authorityKey: string },
      device: DevicePaneSelection,
      options?: OpenInRegionOptions,
    ) =>
      openDeviceInRegion(
        model as NonNullable<typeof model>,
        scope,
        device,
        options,
      ),
    [model],
  );
  return model ? open : null;
}
