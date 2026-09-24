/** Host-neutral mobile inspection. Identifiers never carry host paths or credentials. */
export type MobileDevicePlatform = 'ios' | 'android';

/** The Station's own machine (D13). */
export const LOCAL_MOBILE_DEVICE_HOST_ID = 'local';

/**
 * A device host id: `local`, or an operator-managed SSH device host
 * (`ssh-` + 12 lowercase hex, minted by the server, #1973). Nothing else is
 * a host id, so a path segment or query value is either one of these or
 * refused.
 */
export const MOBILE_DEVICE_HOST_ID_PATTERN = /^(?:local|ssh-[0-9a-f]{12})$/;

export function isMobileDeviceHostId(value: unknown): value is string {
  return typeof value === 'string' && MOBILE_DEVICE_HOST_ID_PATTERN.test(value);
}

export interface MobileDeviceTarget {
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}

export interface MobileDeviceSummary extends MobileDeviceTarget {
  name: string;
  runtime: string;
  booted: boolean;
  /** A Start is booting this device in the background (#1970). */
  starting?: boolean;
  /** The last background Start of this device failed, and why. */
  startError?: MobileDeviceStartError;
}

export type MobileDeviceHostFailure =
  | 'not-configured'
  | 'invalid-configuration'
  | 'hub-unavailable'
  | 'invalid-response'
  | 'response-too-large'
  | 'busy';

export interface MobileDeviceInventory {
  hostId: string;
  state: 'ready' | 'partial' | 'unavailable';
  observedAt: string;
  devices: MobileDeviceSummary[];
  failure?: MobileDeviceHostFailure;
  /**
   * Whether THIS caller may power off devices and end a session for every
   * viewer (the Station operator, #1970 D12). Starting a listed device needs
   * only a share. Absent where the server does not say.
   */
  canManageDevices?: boolean;
}

export type MobileDeviceStartError =
  | 'device-unavailable'
  | 'hub-unavailable'
  | 'invalid-target'
  | 'not-authorized';

/** One captured frame, not stream health or proof of the foreground app's identity. */
export interface MobileDeviceCapture {
  captureId: string;
  target: MobileDeviceTarget;
  capturedAt: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  pngBase64: string;
}

/**
 * An open live session on one device (#1970): the device is streamed and
 * driven through the live surface `surfaceId`. Who may watch and drive it is
 * decided per DEVICE (D12: the Station operator, or an admin of a Project
 * the operator shared that device with). `hostId` names the device host
 * (D13: `local`, or an SSH device host, #1973).
 */
export interface MobileDeviceSession {
  sessionId: string;
  surfaceId: string;
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
  name: string;
  runtime: string;
  openedAt: string;
}

/** Typed refusals of the device session routes. */
export type MobileDeviceSessionFailure =
  | 'invalid-request'
  | 'invalid-target'
  | 'access-denied'
  | 'unavailable'
  | 'device-unavailable'
  | 'device-not-running'
  | 'unknown-session'
  | 'not-authorized'
  | 'hub-unavailable'
  /** A device host is briefly too busy to answer (retry; #1973 D2). */
  | 'device-host-busy';

// ---- SSH device hosts (#1973, D11) ----------------------------------------

/**
 * An operator-managed device host reached over SSH. Station stores no
 * secret: authentication is the operator's own ssh agent and config.
 * `sshTarget` is `user@host[:port]`, `host[:port]`, or an ssh config alias.
 */
export interface DeviceSshHost {
  hostId: string;
  label: string;
  sshTarget: string;
  /** The operator consented to install and run the pinned hub there. */
  hubEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Typed failures of an SSH device host (never raw ssh output). */
export type DeviceSshHostFailure =
  | 'ssh-unavailable'
  | 'host-key-unverified'
  | 'host-key-changed'
  | 'auth-failed'
  | 'unreachable'
  | 'timeout'
  | 'node-missing'
  | 'unsupported-node'
  | 'local-hub-not-installed'
  | 'hub-not-installed'
  | 'hub-not-enabled'
  | 'install-failed'
  | 'start-failed'
  | 'forward-failed'
  | 'forward-unconfirmed'
  | 'protocol';

/** What each failure asks the operator to do, in plain words. */
export const DEVICE_SSH_HOST_GUIDANCE: Readonly<
  Record<DeviceSshHostFailure, string>
> = {
  'ssh-unavailable': 'Station could not run ssh on this machine.',
  'host-key-unverified':
    "This host's key is not in your known_hosts. Connect once with ssh from a terminal and confirm the key, then test again.",
  'host-key-changed':
    "This host's key changed since you last confirmed it. Check with the host's owner before updating known_hosts.",
  'auth-failed':
    'ssh could not sign in without a prompt. Load a key into your ssh agent (or ssh config) that this host accepts.',
  unreachable: 'The host did not answer. Check the address, port and network.',
  timeout: 'The host took too long to answer.',
  'node-missing':
    'Node.js was not found on the host for a non-interactive ssh session.',
  'unsupported-node': 'The host needs Node.js 22 or newer.',
  'local-hub-not-installed':
    'Set up devices on this Station first; the host receives the same verified hub.',
  'hub-not-installed':
    "This host does not have this Station's current device hub (it was never sent, or this Station's pinned hub changed). Reinstalling sends it again.",
  'hub-not-enabled':
    'The Station operator has not enabled the device hub on this host.',
  'install-failed': 'Installing the device hub on the host failed.',
  'start-failed': 'The device hub on the host did not start.',
  'forward-failed': 'Station could not forward a port to the host.',
  'forward-unconfirmed':
    'ssh never reported that it holds the forwarded port, so Station sent nothing to it. Station reads OpenSSH\'s own debug line ("Local forwarding listening on 127.0.0.1 port …", as OpenSSH 8–10 print it); a different ssh client or wording needs a Station update.',
  protocol: 'The host answered in a way Station did not expect.',
};

export type DeviceHostCheckStepId =
  | 'ssh'
  | 'host-key'
  | 'node'
  | 'ios'
  | 'android'
  | 'hub-installed'
  | 'hub-running';

export interface DeviceHostCheckStep {
  id: DeviceHostCheckStepId;
  state: 'pass' | 'fail' | 'warn' | 'skipped';
  /** Short, Station-authored text; never raw remote output. */
  detail?: string;
}

/** The step-by-step "Test connection" result for one SSH device host. */
export interface DeviceHostCheckResult {
  hostId: string;
  checkedAt: string;
  ok: boolean;
  failure?: DeviceSshHostFailure;
  steps: DeviceHostCheckStep[];
}

/** The supervised hub on an SSH device host, as the operator sees it. */
export type DeviceSshHubState =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; startedAt: string }
  | { state: 'restarting'; attempt: number; retryAt: string }
  | { state: 'failed'; failure: DeviceSshHostFailure; attempts: number };

/** Sending the verified hub to an SSH device host. */
export type DeviceSshInstallState =
  | { state: 'unknown' }
  | { state: 'installing' }
  | { state: 'installed' }
  | { state: 'failed'; failure: DeviceSshHostFailure };

/** An SSH device host as the operator's Settings list shows it. */
export interface DeviceSshHostView extends DeviceSshHost {
  hub: DeviceSshHubState;
  install: DeviceSshInstallState;
}

/** One entry of the Device pane's host picker. */
export interface DeviceHostSummary {
  hostId: string;
  label: string;
  kind: 'local' | 'ssh';
  hub?: DeviceSshHubState;
}
