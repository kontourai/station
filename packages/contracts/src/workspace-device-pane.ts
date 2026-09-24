import {
  isMobileDeviceHostId,
  type MobileDevicePlatform,
} from './mobile-device.js';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID = 'pane:builtin:device';
export const WORKSPACE_DEVICE_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-device';
export const WORKSPACE_DEVICE_PANE_RENDERER_NAME = 'workspace-device';
export const WORKSPACE_DEVICE_PANE_SOURCE_ID = 'builtin:workspace-device';
export const WORKSPACE_DEVICE_PANE_INSTANCE_ID = 'workspace-device';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Device Workspace Pane');
  return parsed;
}

/**
 * The Device pane, declared as a Workspace Pane (#1969).
 *
 * A running simulator or emulator, beside the work that uses it: its screen
 * streamed live and its input driven through Station's live surface (#1970;
 * it began as a one-frame snapshot surface in #1969). Watching and driving
 * are authorized per request on the server, not by anything declared here.
 *
 * Three declarations carry the design:
 *
 * - **A requirement-free default mode.** Device inventory is a fact about the
 *   STATION's host (`GET /api/mobile-devices/hosts/local/devices`), not about
 *   a Project: the same simulators are listed whatever is checked out.
 *   Declaring `project: true` would bind an occurrence to something the pane
 *   never reads, and would make it unavailable in a host that places it with
 *   no project — which is exactly the case a dock region hits.
 * - **`docked` placement only.** There is no route that mounts a device
 *   screen and no Project host that should place one: a dock region beside a
 *   conversation is the whole placement story for this slice.
 * - **No `requirements.hostCapabilities`.** Browser Preview declares
 *   `local-browser-preview` because the DESKTOP shell is what renders it.
 *   A live surface is image frames over an authenticated stream — the same
 *   bytes draw in a browser tab and in the desktop webview — so gating this
 *   pane on a desktop capability would refuse a surface that works, and
 *   would be a requirement nothing derives.
 *
 * The SELECTED device is pane STATE (`WorkspaceDevicePaneState`), not pane
 * identity: there is one Device pane per region set, like Activity, and which
 * simulator it is pointed at is what the pane reads rather than what it is.
 * The cost is stated rather than hidden — two devices side by side is not
 * possible until instance-keyed panes (#2049's prefix mechanism) grow a
 * Device family — and the choice is reversible: the descriptor and the
 * registry entry survive that change unaltered.
 *
 * `provenance.origin: 'builtin'` is what the contract's parser uses to refuse
 * a `pluginId` here, so a contributed device pane can never arrive wearing
 * this attribution.
 */
export const WORKSPACE_DEVICE_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
  name: 'Device',
  description: 'Watch and control a simulator or emulator.',
  rendererId: WORKSPACE_DEVICE_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_DEVICE_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['docked'],
    preferredRegion: 'docked',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

function instance(value: unknown): WorkspacePaneInstance {
  const parsed = parseWorkspacePaneInstance(value);
  if (!parsed)
    throw new Error('Invalid built-in Device Workspace Pane instance');
  return parsed;
}

/**
 * The Device pane's single placed occurrence.
 *
 * A constant rather than a factory for Activity's reason: there is nothing to
 * parameterize it with. The selected device is not in here — it is bounded
 * state under `stateKey`, and a target the host cannot see today would make
 * the occurrence unstable across a device list that changes underneath it.
 */
export const WORKSPACE_DEVICE_PANE_INSTANCE = instance({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
  instanceId: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
  stateKey: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
  boundContext: { sourceId: WORKSPACE_DEVICE_PANE_SOURCE_ID },
});

export function isCanonicalWorkspaceDevicePaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  return (
    candidate.descriptorId === WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID &&
    candidate.instanceId === WORKSPACE_DEVICE_PANE_INSTANCE_ID &&
    candidate.stateKey === WORKSPACE_DEVICE_PANE_INSTANCE_ID &&
    candidate.boundContext?.sourceId === WORKSPACE_DEVICE_PANE_SOURCE_ID &&
    candidate.boundContext.projectId === undefined &&
    candidate.boundContext.taskId === undefined &&
    candidate.boundContext.sessionId === undefined &&
    candidate.boundContext.runId === undefined &&
    candidate.boundContext.workspaceId === undefined &&
    candidate.boundContext.contribution === undefined &&
    Object.keys(candidate.boundContext).length === 1
  );
}

export const WORKSPACE_DEVICE_PANE_STATE_VERSION = '1.0' as const;

/**
 * What the Device pane remembers between mounts: WHICH device was selected,
 * and nothing else.
 *
 * Descriptive identity only — the same three fields a `MobileDeviceTarget`
 * carries, which the host already treats as public and re-validates on every
 * capture. Deliberately NOT here: the captured image. A `pngBase64` is a
 * picture of somebody's screen, and persisting it would outlive both the
 * authority that fetched it and the user's expectation that a snapshot is a
 * snapshot. The parser refuses an unknown key for exactly that reason, so a
 * later writer cannot quietly add one.
 */
export interface WorkspaceDevicePaneState {
  version: typeof WORKSPACE_DEVICE_PANE_STATE_VERSION;
  /** `local`, or an SSH device host's id (#1973); nothing else. */
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}

/** A device id's own bound (the host id has its own grammar). */
const MAX_DEVICE_ID_LENGTH = 256;

function isDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEVICE_ID_LENGTH &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function parseWorkspaceDevicePaneState(
  value: unknown,
): WorkspaceDevicePaneState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        key !== 'version' &&
        key !== 'hostId' &&
        key !== 'platform' &&
        key !== 'deviceId',
    ) ||
    row.version !== WORKSPACE_DEVICE_PANE_STATE_VERSION ||
    !isMobileDeviceHostId(row.hostId) ||
    (row.platform !== 'ios' && row.platform !== 'android') ||
    !isDeviceId(row.deviceId)
  )
    return null;
  return {
    version: WORKSPACE_DEVICE_PANE_STATE_VERSION,
    hostId: row.hostId as string,
    platform: row.platform,
    deviceId: row.deviceId,
  };
}
