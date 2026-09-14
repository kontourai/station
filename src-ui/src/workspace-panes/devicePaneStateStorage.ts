import {
  parseWorkspaceDevicePaneState,
  WORKSPACE_DEVICE_PANE_STATE_VERSION,
  type WorkspaceDevicePaneState,
} from '@kontourai/station-contracts/workspace-device-pane';

/**
 * Where the Device pane remembers which device was selected (#1969).
 *
 * Modelled on `filePreviewPaneStateStorage`: a versioned prefix, a byte cap,
 * and a CONTRACT parser rather than a cast, so a value another build (or
 * another tab) wrote is admitted on its shape rather than on trust. What it
 * stores is a descriptive target and nothing else — the parser refuses an
 * unknown key, which is what keeps a captured image out of here.
 *
 * Keyed by the host authority, and pruned to one entry on every write: a
 * selection made against one Station is not an answer about another, and the
 * pane also clears the previous authority's entry when the authority changes
 * (`DeviceWorkspacePane`).
 */
export const DEVICE_PANE_STATE_STORAGE_PREFIX = 'station:device-pane-state:v1';

/** A target is four short fields; anything larger is not one of ours. */
const MAX_DEVICE_PANE_STATE_BYTES = 512;

const utf8 = new TextEncoder();

export interface DevicePaneStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export function devicePaneStateStorageKey(scope: {
  apiBase: string;
  authorityKey: string;
}): string {
  return `${DEVICE_PANE_STATE_STORAGE_PREFIX}:${encodeURIComponent(scope.apiBase)}:${encodeURIComponent(scope.authorityKey)}`;
}

function prefixedKeys(storage: DevicePaneStateStorage): string[] {
  if (typeof storage.length !== 'number' || !storage.key) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${DEVICE_PANE_STATE_STORAGE_PREFIX}:`)) keys.push(key);
  }
  return keys;
}

export function readDevicePaneState(
  storage: DevicePaneStateStorage | null,
  scope: { apiBase: string; authorityKey: string },
): WorkspaceDevicePaneState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(devicePaneStateStorageKey(scope));
    if (!raw || utf8.encode(raw).byteLength > MAX_DEVICE_PANE_STATE_BYTES)
      return null;
    return parseWorkspaceDevicePaneState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDevicePaneState(
  storage: DevicePaneStateStorage | null,
  scope: { apiBase: string; authorityKey: string },
  target: { platform: 'ios' | 'android'; deviceId: string },
): void {
  if (!storage) return;
  const state: WorkspaceDevicePaneState = {
    version: WORKSPACE_DEVICE_PANE_STATE_VERSION,
    hostId: 'local',
    platform: target.platform,
    deviceId: target.deviceId,
  };
  // Round-trip through the contract parser before storing: a value this
  // module would refuse to read is a value it must not write.
  if (!parseWorkspaceDevicePaneState(state)) return;
  const key = devicePaneStateStorageKey(scope);
  try {
    const serialized = JSON.stringify(state);
    if (utf8.encode(serialized).byteLength > MAX_DEVICE_PANE_STATE_BYTES)
      return;
    for (const stale of prefixedKeys(storage))
      if (stale !== key) storage.removeItem(stale);
    storage.setItem(key, serialized);
  } catch {
    /* a full or unavailable store simply does not remember the pick */
  }
}

export function clearDevicePaneState(
  storage: DevicePaneStateStorage | null,
  scope: { apiBase: string; authorityKey: string },
): void {
  if (!storage) return;
  try {
    storage.removeItem(devicePaneStateStorageKey(scope));
  } catch {
    /* nothing to do: the selection is presentation state */
  }
}

/** The browser's store, or null where there is no browser (node unit tests). */
export function devicePaneStorage(): DevicePaneStateStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}
