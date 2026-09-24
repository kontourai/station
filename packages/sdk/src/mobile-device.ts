import {
  type DeviceHostCheckResult,
  type DeviceHostSummary,
  type DeviceSshHostView,
  isMobileDeviceHostId,
  type MobileDeviceCapture,
  type MobileDeviceInventory,
  type MobileDeviceSession,
  type MobileDeviceSessionFailure,
  type MobileDeviceSummary,
  type MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import { type ClientRequestOptions, getJson, mutateJson } from './client/http';

export type {
  DeviceHostCheckResult,
  DeviceHostSummary,
  DeviceSshHostView,
  MobileDeviceCapture,
  MobileDeviceInventory,
  MobileDeviceSession,
  MobileDeviceSessionFailure,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';

const START_ERRORS = [
  'device-unavailable',
  'hub-unavailable',
  'invalid-target',
  'not-authorized',
] as const;

const SESSION_FAILURES: readonly MobileDeviceSessionFailure[] = [
  'invalid-request',
  'invalid-target',
  'access-denied',
  'unavailable',
  'device-unavailable',
  'device-not-running',
  'unknown-session',
  'not-authorized',
  'hub-unavailable',
  'device-host-busy',
];

export class MobileDeviceRequestError extends Error {
  constructor(
    readonly status: number,
    /** The route's typed refusal, when it named one this client knows. */
    readonly code?: MobileDeviceSessionFailure,
  ) {
    super('Mobile device inspection is unavailable.');
    this.name = 'MobileDeviceRequestError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function target(value: unknown): value is MobileDeviceTarget {
  const row = object(value);
  return (
    !!row &&
    isMobileDeviceHostId(row.hostId) &&
    text(row.deviceId) &&
    (row.platform === 'ios' || row.platform === 'android')
  );
}
function summary(value: unknown): value is MobileDeviceSummary {
  const row = object(value);
  return (
    !!row &&
    target(row) &&
    text(row.name) &&
    text(row.runtime) &&
    typeof row.booted === 'boolean' &&
    (row.starting === undefined || typeof row.starting === 'boolean') &&
    (row.startError === undefined ||
      (START_ERRORS as readonly unknown[]).includes(row.startError))
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value))
  );
}
async function data(response: Response): Promise<Record<string, unknown>> {
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = object(await response.json());
  } catch {
    /* generic public error */
  }
  const code = SESSION_FAILURES.find((known) => known === envelope?.code);
  if (!response.ok) throw new MobileDeviceRequestError(response.status, code);
  const value = object(envelope?.data);
  if (envelope?.success !== true || !value)
    throw new MobileDeviceRequestError(response.status, code);
  return value;
}

/** Explicit API base keeps a device host bound to the selected Station. */
export async function fetchMobileDeviceInventory(
  apiBase: string,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
  /** The device host (#1973): `local`, or an SSH device host's id. */
  hostId = 'local',
): Promise<MobileDeviceInventory> {
  if (!isMobileDeviceHostId(hostId)) throw new MobileDeviceRequestError(400);
  const result = await data(
    await getJson(
      `${apiBase}/api/mobile-devices/hosts/${hostId}/devices${projectQuery(projectSlug)}`,
      {
        ...options,
        maxResponseBytes: 512 * 1024,
      },
    ),
  );
  const failures = [
    'not-configured',
    'invalid-configuration',
    'hub-unavailable',
    'invalid-response',
    'response-too-large',
    'busy',
  ];
  if (
    result.hostId !== hostId ||
    !['ready', 'partial', 'unavailable'].includes(String(result.state)) ||
    !timestamp(result.observedAt) ||
    !Array.isArray(result.devices) ||
    result.devices.length > 256 ||
    !result.devices.every(summary) ||
    !result.devices.every(
      (device: { hostId?: unknown }) => device.hostId === hostId,
    ) ||
    (result.state === 'unavailable'
      ? !failures.includes(String(result.failure)) ||
        result.devices.length !== 0
      : result.failure !== undefined) ||
    (result.canManageDevices !== undefined &&
      typeof result.canManageDevices !== 'boolean')
  )
    throw new MobileDeviceRequestError(200);
  return result as unknown as MobileDeviceInventory;
}

/**
 * Whether `captureMobileDevice` will send a request for this target at all.
 *
 * This client refuses a device id it does not recognise BEFORE anything
 * leaves the browser — an iOS simulator id must be a UDID, an Android one an
 * `emulator-<n>` serial — and the refusal is an indistinguishable
 * `MobileDeviceRequestError(400)`. The host's own listing rule is wider than
 * that in one case: it only enforces the emulator-serial spelling for a
 * BOOTED Android device, so an inventory can legitimately contain a row this
 * function answers `false` for.
 *
 * Exported so a caller can ask BEFORE offering the press, rather than
 * discovering it as a failed capture — and exported rather than copied,
 * because a second reader of this rule is a second reader that eventually
 * gets it wrong. Widening the rule is a change to the validator, not to a
 * consumer's mirror of it.
 */
export function isCaptureableMobileDeviceTarget(
  selected: MobileDeviceTarget,
): boolean {
  return (
    target(selected) &&
    (selected.platform === 'ios'
      ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selected.deviceId)
      : /^emulator-[0-9]+$/.test(selected.deviceId))
  );
}

/** Capture is explicit and bounded. It does not create a stream or boot a device. */
export async function captureMobileDevice(
  apiBase: string,
  selected: MobileDeviceTarget,
  options?: ClientRequestOptions,
): Promise<MobileDeviceCapture> {
  if (!isCaptureableMobileDeviceTarget(selected))
    throw new MobileDeviceRequestError(400);
  const expected = { ...selected };
  const path = `/api/mobile-devices/hosts/${encodeURIComponent(expected.hostId)}/devices/${expected.platform}/${encodeURIComponent(expected.deviceId)}/capture`;
  const result = await data(
    await mutateJson(
      `${apiBase}${path}`,
      'POST',
      {
        ...options,
        readOnly: true,
        maxResponseBytes: 12 * 1024 * 1024,
      },
      {},
    ),
  );
  const received = object(result.target);
  if (
    !text(result.captureId) ||
    !received ||
    received.hostId !== expected.hostId ||
    received.platform !== expected.platform ||
    received.deviceId !== expected.deviceId ||
    !timestamp(result.capturedAt) ||
    result.mimeType !== 'image/png' ||
    typeof result.width !== 'number' ||
    !Number.isInteger(result.width) ||
    result.width < 1 ||
    result.width > 8192 ||
    typeof result.height !== 'number' ||
    !Number.isInteger(result.height) ||
    result.height < 1 ||
    result.height > 8192 ||
    typeof result.pngBase64 !== 'string' ||
    result.pngBase64.length > 11_184_812 ||
    !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(result.pngBase64)
  )
    throw new MobileDeviceRequestError(200);
  return result as unknown as MobileDeviceCapture;
}

// ---- live device sessions (#1970) -------------------------------------------

const SURFACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANDROID_ANY_ID = /^[a-zA-Z0-9_.-]{1,256}$/;
const IOS_UDID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function session(value: unknown): value is MobileDeviceSession {
  const row = object(value);
  return (
    !!row &&
    target(row) &&
    typeof row.sessionId === 'string' &&
    SESSION_ID.test(row.sessionId) &&
    typeof row.surfaceId === 'string' &&
    SURFACE_ID.test(row.surfaceId) &&
    text(row.name) &&
    text(row.runtime) &&
    timestamp(row.openedAt)
  );
}

/**
 * Any device id the session routes may address: an iOS UDID, or an Android
 * serial OR a stopped AVD's name (Start addresses a device that has no
 * serial yet).
 */
function addressable(selected: MobileDeviceTarget): boolean {
  return (
    target(selected) &&
    (selected.platform === 'ios'
      ? IOS_UDID.test(selected.deviceId)
      : ANDROID_ANY_ID.test(selected.deviceId))
  );
}

const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * `?projectSlug=` for a device request made from a Project (D12): device
 * shares are per Project, so a Project admin reaches a shared device only
 * when the request names the Project it is shared with. The operator needs
 * none. A slug this client would not send is dropped, not guessed at.
 */
function projectQuery(projectSlug: string | null | undefined): string {
  return projectSlug && PROJECT_SLUG.test(projectSlug)
    ? `?projectSlug=${encodeURIComponent(projectSlug)}`
    : '';
}

function devicePath(
  selected: MobileDeviceTarget,
  action: string,
  projectSlug: string | null | undefined,
): string {
  return `/api/mobile-devices/hosts/${selected.hostId}/devices/${selected.platform}/${encodeURIComponent(selected.deviceId)}/${action}${projectQuery(projectSlug)}`;
}

export async function fetchMobileDeviceSessions(
  apiBase: string,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
  hostId = 'local',
): Promise<MobileDeviceSession[]> {
  if (!isMobileDeviceHostId(hostId)) throw new MobileDeviceRequestError(400);
  const result = await data(
    await getJson(
      `${apiBase}/api/mobile-devices/hosts/${hostId}/sessions${projectQuery(projectSlug)}`,
      { ...options, maxResponseBytes: 256 * 1024 },
    ),
  );
  if (
    !Array.isArray(result.sessions) ||
    result.sessions.length > 256 ||
    !result.sessions.every(session) ||
    !result.sessions.every((row: { hostId?: unknown }) => row.hostId === hostId)
  )
    throw new MobileDeviceRequestError(200);
  return result.sessions as MobileDeviceSession[];
}

/**
 * Start a stopped device. The server answers at once — `starting` while it
 * boots in the background, `running` when it already was — and a caller
 * polls the device list for it to come up (an Android emulator reappears
 * under its `emulator-<n>` serial, so match by platform and name).
 */
export async function startMobileDevice(
  apiBase: string,
  selected: MobileDeviceTarget,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
): Promise<{ deviceId: string; state: 'running' | 'starting' }> {
  if (!addressable(selected)) throw new MobileDeviceRequestError(400);
  const result = await data(
    await mutateJson(
      `${apiBase}${devicePath(selected, 'start', projectSlug)}`,
      'POST',
      { ...options, maxResponseBytes: 16 * 1024 },
      {},
    ),
  );
  if (
    !text(result.deviceId) ||
    (result.state !== 'running' && result.state !== 'starting')
  )
    throw new MobileDeviceRequestError(200);
  return { deviceId: result.deviceId, state: result.state };
}

/** Open (or join) the live session on a running device. */
export async function openMobileDeviceSession(
  apiBase: string,
  selected: MobileDeviceTarget,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
): Promise<MobileDeviceSession> {
  if (!addressable(selected)) throw new MobileDeviceRequestError(400);
  const result = await data(
    await mutateJson(
      `${apiBase}${devicePath(selected, 'sessions', projectSlug)}`,
      'POST',
      { ...options, maxResponseBytes: 16 * 1024 },
      {},
    ),
  );
  if (
    !session(result) ||
    result.hostId !== selected.hostId ||
    result.platform !== selected.platform ||
    result.deviceId !== selected.deviceId
  )
    throw new MobileDeviceRequestError(200);
  return result;
}

/** Stop watching: end the session. The device keeps running. */
export async function closeMobileDeviceSession(
  apiBase: string,
  sessionId: string,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
  hostId = 'local',
): Promise<void> {
  if (!SESSION_ID.test(sessionId) || !isMobileDeviceHostId(hostId))
    throw new MobileDeviceRequestError(400);
  await data(
    await mutateJson(
      `${apiBase}/api/mobile-devices/hosts/${hostId}/sessions/${sessionId}${projectQuery(projectSlug)}`,
      'DELETE',
      { ...options, maxResponseBytes: 16 * 1024 },
    ),
  );
}

/** Shut the device down. Ends its session first. */
export async function powerOffMobileDevice(
  apiBase: string,
  selected: MobileDeviceTarget,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
): Promise<void> {
  if (!addressable(selected)) throw new MobileDeviceRequestError(400);
  await data(
    await mutateJson(
      `${apiBase}${devicePath(selected, 'power-off', projectSlug)}`,
      'POST',
      { ...options, maxResponseBytes: 16 * 1024 },
      {},
    ),
  );
}

// ---- device hosts (#1973) ---------------------------------------------------

const HUB_STATES = ['stopped', 'starting', 'running', 'restarting', 'failed'];

function hostSummary(value: unknown): value is DeviceHostSummary {
  const row = object(value);
  return (
    !!row &&
    isMobileDeviceHostId(row.hostId) &&
    text(row.label) &&
    (row.kind === 'local' || row.kind === 'ssh') &&
    (row.hub === undefined ||
      HUB_STATES.includes(String(object(row.hub)?.state)))
  );
}

/**
 * The device hosts the Device pane may pick from: `local` first, then the
 * operator's SSH device hosts (labels only; never an ssh target).
 */
export async function fetchMobileDeviceHosts(
  apiBase: string,
  options?: ClientRequestOptions,
  projectSlug?: string | null,
): Promise<DeviceHostSummary[]> {
  const result = await data(
    await getJson(
      `${apiBase}/api/mobile-devices/hosts${projectQuery(projectSlug)}`,
      { ...options, maxResponseBytes: 64 * 1024 },
    ),
  );
  if (
    !Array.isArray(result.hosts) ||
    result.hosts.length > 64 ||
    !result.hosts.every(hostSummary)
  )
    throw new MobileDeviceRequestError(200);
  return result.hosts as DeviceHostSummary[];
}

/** A typed refusal from the operator's SSH device host routes. */
export class DeviceHostRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super('The device host request was refused.');
    this.name = 'DeviceHostRequestError';
  }
}

const HOST_CODE = /^[a-z][a-z-]{0,39}$/;

async function hostData(response: Response): Promise<Record<string, unknown>> {
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = object(await response.json());
  } catch {
    /* generic refusal */
  }
  const code =
    typeof envelope?.code === 'string' && HOST_CODE.test(envelope.code)
      ? envelope.code
      : undefined;
  const value = object(envelope?.data);
  if (!response.ok || envelope?.success !== true || !value)
    throw new DeviceHostRequestError(response.status, code);
  return value;
}

function hostView(value: unknown): value is DeviceSshHostView {
  const row = object(value);
  return (
    !!row &&
    isMobileDeviceHostId(row.hostId) &&
    row.hostId !== 'local' &&
    text(row.label) &&
    text(row.sshTarget) &&
    typeof row.hubEnabled === 'boolean' &&
    !!object(row.hub) &&
    !!object(row.install)
  );
}

function hostPath(hostId: string, suffix = ''): string {
  if (!isMobileDeviceHostId(hostId) || hostId === 'local')
    throw new DeviceHostRequestError(400, 'invalid-request');
  return `/api/mobile-devices/device-hosts/${hostId}${suffix}`;
}

/** The operator's SSH device hosts (operator only). */
export async function fetchDeviceSshHosts(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<DeviceSshHostView[]> {
  const result = await hostData(
    await getJson(`${apiBase}/api/mobile-devices/device-hosts`, {
      ...options,
      maxResponseBytes: 128 * 1024,
    }),
  );
  if (!Array.isArray(result.hosts) || !result.hosts.every(hostView))
    throw new DeviceHostRequestError(200);
  return result.hosts as DeviceSshHostView[];
}

async function hostMutation(
  apiBase: string,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  options?: ClientRequestOptions,
): Promise<Record<string, unknown>> {
  return hostData(
    await mutateJson(
      `${apiBase}${path}`,
      method,
      { ...options, maxResponseBytes: 64 * 1024 },
      body,
    ),
  );
}

export async function addDeviceSshHost(
  apiBase: string,
  input: { label: string; sshTarget: string },
  options?: ClientRequestOptions,
): Promise<DeviceSshHostView> {
  const result = await hostMutation(
    apiBase,
    '/api/mobile-devices/device-hosts',
    'POST',
    { label: input.label, sshTarget: input.sshTarget },
    options,
  );
  if (!hostView(result)) throw new DeviceHostRequestError(200);
  return result;
}

export async function updateDeviceSshHost(
  apiBase: string,
  hostId: string,
  input: { label?: string; sshTarget?: string },
  options?: ClientRequestOptions,
): Promise<DeviceSshHostView> {
  const result = await hostMutation(
    apiBase,
    hostPath(hostId),
    'PATCH',
    {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.sshTarget !== undefined ? { sshTarget: input.sshTarget } : {}),
    },
    options,
  );
  if (!hostView(result)) throw new DeviceHostRequestError(200);
  return result;
}

export async function removeDeviceSshHost(
  apiBase: string,
  hostId: string,
  options?: ClientRequestOptions,
): Promise<void> {
  await hostMutation(apiBase, hostPath(hostId), 'DELETE', undefined, options);
}

/** "Test connection": the step-by-step check. Starts and installs nothing. */
export async function checkDeviceSshHost(
  apiBase: string,
  hostId: string,
  options?: ClientRequestOptions,
): Promise<DeviceHostCheckResult> {
  const result = await hostMutation(
    apiBase,
    hostPath(hostId, '/check'),
    'POST',
    {},
    options,
  );
  if (result.hostId !== hostId || !Array.isArray(result.steps))
    throw new DeviceHostRequestError(200);
  return result as unknown as DeviceHostCheckResult;
}

/** Enable (with the operator's consent) or disable the hub on a host. */
export async function setDeviceSshHub(
  apiBase: string,
  hostId: string,
  request: { enabled: true; consent: true } | { enabled: false },
  options?: ClientRequestOptions,
): Promise<DeviceSshHostView> {
  const result = await hostMutation(
    apiBase,
    hostPath(hostId, '/hub'),
    'POST',
    request,
    options,
  );
  if (!hostView(result)) throw new DeviceHostRequestError(200);
  return result;
}

export async function startDeviceSshHub(
  apiBase: string,
  hostId: string,
  options?: ClientRequestOptions,
): Promise<DeviceSshHostView> {
  const result = await hostMutation(
    apiBase,
    hostPath(hostId, '/hub/start'),
    'POST',
    {},
    options,
  );
  if (!hostView(result)) throw new DeviceHostRequestError(200);
  return result;
}
