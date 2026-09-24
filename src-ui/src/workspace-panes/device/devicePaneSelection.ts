/**
 * "Show this device" for a Device pane that is ALREADY mounted (#90 D9: the
 * float-over-chat's "Open in right panel"). A pane that mounts later reads
 * the stored selection (`devicePaneStateStorage`) instead; a mounted one
 * read it once, so it is told here. A module seam rather than a context: the
 * float and the pane mount under different providers.
 */

export interface DevicePaneSelection {
  hostId: string;
  platform: 'ios' | 'android';
  deviceId: string;
}

const listeners = new Set<(selection: DevicePaneSelection) => void>();

/** Tell every mounted Device pane to show this device. */
export function selectDeviceInPane(selection: DevicePaneSelection): void {
  for (const listener of listeners) listener(selection);
}

/** A mounted Device pane's subscription; returns its release. */
export function onDevicePaneSelection(
  listener: (selection: DevicePaneSelection) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
