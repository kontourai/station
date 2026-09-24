/**
 * The Device pane's Tools drawer, server side (#1971, owner decision D10).
 *
 * Typed device settings and one-shot actions, run by Station itself against
 * `xcrun simctl` (iOS) and `adb` (Android), and the value each one leaves on
 * the device, READ BACK afterwards. Never a generic shell:
 *
 * - every action is one member of `DeviceToolAction`, turned into an
 *   argument vector by a builder below that validates each input (a UDID or
 *   emulator serial, a dotted app id, a permission from a fixed table,
 *   coordinates formatted by Station);
 * - every vector, whoever built it, must then match one of the fixed
 *   {@link DEVICE_TOOL_ARGV_SHAPES} before it runs (`exec` refuses anything
 *   else), and it runs through `execFile` with no shell;
 * - a push payload travels on stdin, never in argv.
 *
 * `adb shell` hands its arguments to the DEVICE's shell joined by spaces, so
 * every free-form argument on that path is restricted to characters no shell
 * treats specially (the app id pattern allows only letters, digits, `_`,
 * `-` and dots).
 *
 * The accessibility tree and the iOS foreground app are read from the device
 * hub through its allowlisted connection (`device-hub-endpoint.ts`), never a
 * route the hub guard does not already admit.
 *
 * Who may call any of this — the operator, or an admin of a Project the
 * device is shared with, view for reads and drive for actions, and nobody
 * while ANOTHER controller holds the device's live-surface lease — is the
 * route's job (`routes/device-tools.ts`); {@link deviceControlConflict}
 * is the lease half of it.
 *
 * Adapted from t3code (apps/server/src/device/DeviceActions.ts and
 * apps/web/src/components/device/deviceHubApi.ts), MIT License, Copyright
 * (c) 2026 T3 Tools Inc. Unlike t3code, iOS permission changes use only
 * `simctl privacy` (no serve-sim CLI), and nothing here runs a helper binary
 * spawned inside the simulator.
 */
import type {
  DeviceAccessibilityElement,
  DeviceAccessibilityTree,
  DeviceAppearance,
  DeviceLocation,
  DeviceLocationReadBack,
  DevicePermission,
  DevicePermissionDecision,
  DevicePermissionState,
  DevicePermissionsReadBack,
  DeviceReadBack,
  DeviceToolAction,
  DeviceToolActionResult,
  DeviceToolsCapabilities,
  DeviceToolsSnapshot,
  DeviceToolsUnreadableReason,
} from '@kontourai/station-contracts/device-tools';
import {
  DEVICE_APP_ID_MAX_LENGTH,
  DEVICE_AX_ELEMENT_LIMIT,
  DEVICE_AX_RESPONSE_MAX_BYTES,
  DEVICE_PUSH_PAYLOAD_MAX_BYTES,
} from '@kontourai/station-contracts/device-tools';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import {
  DeviceToolError,
  locateExecutable,
  runBoundedToolCapture,
  standardAdbDirs,
} from './device-host-tools.js';
import type { DeviceHubEndpoint } from './device-hub-endpoint.js';

export type DeviceTool = 'xcrun' | 'adb';

export type DeviceToolsErrorCode =
  | 'invalid-request'
  | 'invalid-target'
  | 'payload-too-large'
  | 'unsupported'
  | 'tool-unavailable'
  | 'tool-failed'
  | 'tool-timeout'
  | 'hub-unavailable';

export class DeviceToolsError extends Error {
  constructor(readonly code: DeviceToolsErrorCode) {
    super(`Device tool refused: ${code}`);
    this.name = 'DeviceToolsError';
  }
}

// ---- identifiers --------------------------------------------------------

const IOS_UDID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Tools act on a RUNNING emulator, which the hub lists by its serial. */
const EMULATOR_SERIAL = /^emulator-[0-9]{1,5}$/;
/**
 * An iOS bundle id or Android package: at least two dot-separated segments
 * of letters, digits, `_` and `-`, starting with a letter. No shell
 * character, no leading `-` (it could read as an option), no path.
 */
const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

export function isDeviceToolsTarget(
  platform: MobileDevicePlatform,
  deviceId: string,
): boolean {
  return platform === 'ios'
    ? IOS_UDID.test(deviceId)
    : platform === 'android' && EMULATOR_SERIAL.test(deviceId);
}

export function isDeviceAppId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DEVICE_APP_ID_MAX_LENGTH &&
    APP_ID.test(value)
  );
}

function assertTarget(platform: MobileDevicePlatform, deviceId: string): void {
  if (!isDeviceToolsTarget(platform, deviceId))
    throw new DeviceToolsError('invalid-target');
}

function assertAppId(appId: string): void {
  if (!isDeviceAppId(appId)) throw new DeviceToolsError('invalid-request');
}

// ---- fixed tables -------------------------------------------------------

/** `simctl privacy` services, by drawer permission (iOS has no camera verb). */
const IOS_PRIVACY_SERVICES: Partial<Record<DevicePermission, string>> = {
  calendar: 'calendar',
  contacts: 'contacts',
  location: 'location',
  'media-library': 'media-library',
  microphone: 'microphone',
  motion: 'motion',
  photos: 'photos',
  reminders: 'reminders',
};

/** Runtime permissions, by drawer permission (from t3code, see header). */
const ANDROID_PERMISSIONS: Partial<
  Record<DevicePermission, readonly string[]>
> = {
  camera: ['android.permission.CAMERA'],
  microphone: ['android.permission.RECORD_AUDIO'],
  photos: [
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_EXTERNAL_STORAGE',
  ],
  contacts: [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
  ],
  calendar: [
    'android.permission.READ_CALENDAR',
    'android.permission.WRITE_CALENDAR',
  ],
  location: [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  motion: ['android.permission.ACTIVITY_RECOGNITION'],
};

const IOS_DECISIONS: readonly DevicePermissionDecision[] = [
  'grant',
  'revoke',
  'reset',
];
/** `pm` has no per-permission reset that works across API levels. */
const ANDROID_DECISIONS: readonly DevicePermissionDecision[] = [
  'grant',
  'revoke',
];

function deviceToolsCapabilities(
  platform: MobileDevicePlatform,
): DeviceToolsCapabilities {
  return platform === 'ios'
    ? {
        appearance: true,
        location: true,
        clearLocation: true,
        push: true,
        permissions: Object.keys(IOS_PRIVACY_SERVICES) as DevicePermission[],
        permissionDecisions: IOS_DECISIONS,
        accessibility: true,
      }
    : {
        appearance: true,
        location: true,
        // The emulator has no "clear": a fix stays until replaced.
        clearLocation: false,
        // An FCM message cannot be simulated without the app's own receiver.
        push: false,
        permissions: Object.keys(ANDROID_PERMISSIONS) as DevicePermission[],
        permissionDecisions: ANDROID_DECISIONS,
        accessibility: true,
      };
}

// ---- argument vectors ---------------------------------------------------

type ArgPart = string | RegExp;

function oneOf(values: readonly string[]): RegExp {
  return new RegExp(
    `^(?:${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  );
}

const APPEARANCE = /^(?:light|dark)$/;
const NIGHT = /^(?:yes|no)$/;
/** Station formats every coordinate with exactly six decimals. */
const COORDINATE = /^-?[0-9]{1,3}\.[0-9]{6}$/;
const COORDINATE_PAIR = /^-?[0-9]{1,2}\.[0-9]{6},-?[0-9]{1,3}\.[0-9]{6}$/;
const IOS_SERVICE = oneOf(Object.values(IOS_PRIVACY_SERVICES) as string[]);
const ANDROID_PERMISSION_NAME = oneOf(
  Object.values(ANDROID_PERMISSIONS).flat() as string[],
);

/**
 * Every argument vector the Tools drawer may run, per tool. `exec` refuses a
 * vector that does not match one of these part for part (a string is a
 * literal, a RegExp a full match), whoever built it.
 */
export const DEVICE_TOOL_ARGV_SHAPES: Readonly<
  Record<DeviceTool, readonly (readonly ArgPart[])[]>
> = {
  xcrun: [
    ['simctl', 'ui', IOS_UDID, 'appearance'],
    ['simctl', 'ui', IOS_UDID, 'appearance', APPEARANCE],
    ['simctl', 'location', IOS_UDID, 'set', COORDINATE_PAIR],
    ['simctl', 'location', IOS_UDID, 'clear'],
    ['simctl', 'privacy', IOS_UDID, oneOf(IOS_DECISIONS), IOS_SERVICE, APP_ID],
    // The payload is read from stdin (`-`), never argv.
    ['simctl', 'push', IOS_UDID, APP_ID, '-'],
  ],
  adb: [
    ['-s', EMULATOR_SERIAL, 'shell', 'cmd', 'uimode', 'night'],
    ['-s', EMULATOR_SERIAL, 'shell', 'cmd', 'uimode', 'night', NIGHT],
    ['-s', EMULATOR_SERIAL, 'emu', 'geo', 'fix', COORDINATE, COORDINATE],
    ['-s', EMULATOR_SERIAL, 'shell', 'dumpsys', 'location'],
    ['-s', EMULATOR_SERIAL, 'shell', 'dumpsys', 'window'],
    ['-s', EMULATOR_SERIAL, 'shell', 'dumpsys', 'package', APP_ID],
    [
      '-s',
      EMULATOR_SERIAL,
      'shell',
      'pm',
      oneOf(ANDROID_DECISIONS),
      APP_ID,
      ANDROID_PERMISSION_NAME,
    ],
  ],
};

/** Whether `args` for `tool` is one of the fixed shapes, exactly. */
export function isAllowedDeviceToolArgv(
  tool: DeviceTool,
  args: readonly string[],
): boolean {
  const shapes = DEVICE_TOOL_ARGV_SHAPES[tool];
  if (!shapes) return false;
  return shapes.some(
    (shape) =>
      shape.length === args.length &&
      shape.every((part, index) => {
        const arg = args[index];
        if (typeof arg !== 'string' || arg.length > 512) return false;
        return typeof part === 'string' ? arg === part : part.test(arg);
      }),
  );
}

function coordinate(value: number, limit: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new DeviceToolsError('invalid-request');
  if (Math.abs(value) > limit) throw new DeviceToolsError('invalid-request');
  // `-0.000000` would read oddly to a tool; zero is zero.
  const text = value.toFixed(6);
  return text === '-0.000000' ? '0.000000' : text;
}

/** The exact argument vectors each typed operation runs. */
export const deviceToolArgv = {
  iosAppearance: (udid: string, set?: DeviceAppearance): string[] => [
    'simctl',
    'ui',
    udid,
    'appearance',
    ...(set ? [set] : []),
  ],
  iosSetLocation: (udid: string, location: DeviceLocation): string[] => [
    'simctl',
    'location',
    udid,
    'set',
    `${coordinate(location.latitude, 90)},${coordinate(location.longitude, 180)}`,
  ],
  iosClearLocation: (udid: string): string[] => [
    'simctl',
    'location',
    udid,
    'clear',
  ],
  iosPrivacy: (
    udid: string,
    decision: DevicePermissionDecision,
    permission: DevicePermission,
    appId: string,
  ): string[] => {
    const service = Object.hasOwn(IOS_PRIVACY_SERVICES, permission)
      ? IOS_PRIVACY_SERVICES[permission]
      : undefined;
    if (!service) throw new DeviceToolsError('unsupported');
    if (!IOS_DECISIONS.includes(decision))
      throw new DeviceToolsError('invalid-request');
    assertAppId(appId);
    return ['simctl', 'privacy', udid, decision, service, appId];
  },
  iosPush: (udid: string, appId: string): string[] => {
    assertAppId(appId);
    return ['simctl', 'push', udid, appId, '-'];
  },
  androidNight: (serial: string, set?: DeviceAppearance): string[] => [
    '-s',
    serial,
    'shell',
    'cmd',
    'uimode',
    'night',
    ...(set ? [set === 'dark' ? 'yes' : 'no'] : []),
  ],
  androidSetLocation: (serial: string, location: DeviceLocation): string[] => [
    '-s',
    serial,
    'emu',
    'geo',
    'fix',
    // `geo fix` takes LONGITUDE first.
    coordinate(location.longitude, 180),
    coordinate(location.latitude, 90),
  ],
  androidDumpsys: (
    serial: string,
    service: 'location' | 'window',
  ): string[] => ['-s', serial, 'shell', 'dumpsys', service],
  androidDumpsysPackage: (serial: string, appId: string): string[] => {
    assertAppId(appId);
    return ['-s', serial, 'shell', 'dumpsys', 'package', appId];
  },
  androidPermissions: (
    serial: string,
    decision: DevicePermissionDecision,
    permission: DevicePermission,
    appId: string,
  ): string[][] => {
    const names = Object.hasOwn(ANDROID_PERMISSIONS, permission)
      ? ANDROID_PERMISSIONS[permission]
      : undefined;
    if (!names) throw new DeviceToolsError('unsupported');
    if (decision !== 'grant' && decision !== 'revoke')
      throw new DeviceToolsError('unsupported');
    assertAppId(appId);
    return names.map((name) => [
      '-s',
      serial,
      'shell',
      'pm',
      decision,
      appId,
      name,
    ]);
  },
};

// ---- push payload -------------------------------------------------------

/**
 * A push payload as `simctl push` takes it: a JSON object with an `aps`
 * object, at most {@link DEVICE_PUSH_PAYLOAD_MAX_BYTES} bytes serialized.
 * Returns the exact bytes sent on stdin.
 */
export function encodeDevicePushPayload(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    throw new DeviceToolsError('invalid-request');
  const aps = (payload as Record<string, unknown>).aps;
  if (aps === null || typeof aps !== 'object' || Array.isArray(aps))
    throw new DeviceToolsError('invalid-request');
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new DeviceToolsError('invalid-request');
  }
  if (Buffer.byteLength(encoded, 'utf8') > DEVICE_PUSH_PAYLOAD_MAX_BYTES)
    throw new DeviceToolsError('payload-too-large');
  return encoded;
}

// ---- output parsers -----------------------------------------------------

function parseIosAppearance(stdout: string): DeviceAppearance | null {
  const value = stdout.trim().toLowerCase();
  return value === 'light' || value === 'dark' ? value : null;
}

function parseAndroidNight(stdout: string): DeviceAppearance | null {
  const match = /Night mode:\s*(yes|no)\b/i.exec(stdout);
  if (!match) return null;
  return match[1]!.toLowerCase() === 'yes' ? 'dark' : 'light';
}

/**
 * The focused app from `dumpsys window` (`mCurrentFocus` or
 * `mFocusedApp`). `dumpsys window windows` stopped printing the focus on
 * API 36; the unfiltered dump still does (t3code).
 */
export function parseAndroidForeground(
  stdout: string,
): { appId: string } | null | undefined {
  const match =
    /m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([A-Za-z0-9_.-]+)\//.exec(
      stdout,
    );
  if (match && isDeviceAppId(match[1])) return { appId: match[1]! };
  if (/mCurrentFocus=null/.test(stdout)) return null;
  return undefined;
}

/** The last fix a location provider reports in `dumpsys location`. */
export function parseAndroidLocation(stdout: string): DeviceLocation | null {
  const match =
    /last location=Location\[\w+ (-?[0-9]+(?:\.[0-9]+)?),(-?[0-9]+(?:\.[0-9]+)?)/.exec(
      stdout,
    );
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

/**
 * Runtime permission state for one package from `dumpsys package`. A group
 * is `granted` when any of its permissions is, `denied` when one is listed
 * and none is granted, and `not-requested` when the app lists none of them.
 * Undefined when the dump does not describe that package at all.
 */
export function parseAndroidPermissions(
  stdout: string,
  appId: string,
): Partial<Record<DevicePermission, DevicePermissionState>> | undefined {
  if (!stdout.includes(`Package [${appId}]`)) return undefined;
  const states = new Map<string, boolean>();
  for (const match of stdout.matchAll(
    /(android\.permission\.[A-Z_]+): granted=(true|false)/g,
  )) {
    // A permission listed as granted anywhere (install or runtime) is.
    states.set(
      match[1]!,
      states.get(match[1]!) === true || match[2] === 'true',
    );
  }
  const out: Partial<Record<DevicePermission, DevicePermissionState>> = {};
  for (const [permission, names] of Object.entries(ANDROID_PERMISSIONS) as [
    DevicePermission,
    readonly string[],
  ][]) {
    const listed = names.filter((name) => states.has(name));
    out[permission] =
      listed.length === 0
        ? 'not-requested'
        : listed.some((name) => states.get(name) === true)
          ? 'granted'
          : 'denied';
  }
  return out;
}

/** The foreground app the serve-sim helper reports for a simulator. */
function parseIosForeground(
  payload: unknown,
): { appId: string } | null | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['bundleId', 'bundleIdentifier', 'appId']) {
    const value = record[key];
    if (value === null || value === '') return null;
    if (isDeviceAppId(value)) return { appId: value };
  }
  return undefined;
}

// ---- accessibility ------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const LABEL_MAX = 200;

function boundedText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, LABEL_MAX) : '';
}

/**
 * serve-sim's helper answers the native nested tree; the first root is the
 * application covering the whole screen. Flatten it the way t3code does
 * (see the header): skip nodes the size of the screen, cap the count.
 */
export function flattenIosAccessibility(
  payload: unknown,
): Omit<DeviceAccessibilityTree, 'readAt'> | undefined {
  if (!Array.isArray(payload)) return undefined;
  const first = payload[0];
  const rootFrame =
    isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const width = Math.max(1, numberOr(rootFrame?.width, 1));
  const height = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAccessibilityElement[] = [];
  let truncated = false;
  const visit = (node: unknown, path: string, depth: number) => {
    if (depth > 64 || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const w = numberOr(frame.width, 0);
    const h = numberOr(frame.height, 0);
    const coversScreen =
      Math.abs(w - width) < 0.5 && Math.abs(h - height) < 0.5;
    if (!coversScreen && w > 0 && h > 0) {
      if (elements.length >= DEVICE_AX_ELEMENT_LIMIT) {
        truncated = true;
        return;
      }
      elements.push({
        id:
          typeof node.AXUniqueId === 'string'
            ? node.AXUniqueId.slice(0, 128)
            : path,
        label: boundedText(node.AXLabel),
        role: boundedText(node.type),
        x: clampUnit(numberOr(frame.x, 0) / width),
        y: clampUnit(numberOr(frame.y, 0) / height),
        width: clampUnit(w / width),
        height: clampUnit(h / height),
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) =>
      visit(child, `${path}.${index}`, depth + 1),
    );
  };
  payload.forEach((root, index) => visit(root, String(index), 0));
  return { space: { width, height }, elements, truncated };
}

/**
 * serve-emu answers uiautomator's flat node list, pixel bounds, the first
 * node the whole window. Layout containers that span the window are
 * dropped, and so are nodes with neither a label nor a click target.
 */
export function flattenAndroidAccessibility(
  payload: unknown,
): Omit<DeviceAccessibilityTree, 'readAt'> | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) return undefined;
  const nodes = payload.nodes.filter(
    (node): node is Record<string, unknown> =>
      isRecord(node) && isRecord(node.bounds),
  );
  const root = nodes[0]?.bounds as Record<string, unknown> | undefined;
  const width = Math.max(1, numberOr(root?.right, 1));
  const height = Math.max(1, numberOr(root?.bottom, 1));
  const elements: DeviceAccessibilityElement[] = [];
  let truncated = false;
  for (const [index, node] of nodes.slice(1).entries()) {
    const bounds = node.bounds as Record<string, unknown>;
    const left = numberOr(bounds.left, 0);
    const top = numberOr(bounds.top, 0);
    const w = (numberOr(bounds.right, left) - left) / width;
    const h = (numberOr(bounds.bottom, top) - top) / height;
    const label =
      boundedText(node.text) || boundedText(node.contentDescription);
    if (w <= 0 || h <= 0) continue;
    if (w >= 0.95 && h >= 0.9) continue;
    if (!label && node.clickable !== true) continue;
    if (elements.length >= DEVICE_AX_ELEMENT_LIMIT) {
      truncated = true;
      break;
    }
    const className = boundedText(node.className);
    elements.push({
      id:
        typeof node.id === 'string' || typeof node.id === 'number'
          ? String(node.id).slice(0, 128)
          : String(index + 1),
      label,
      role: className.split('.').at(-1) ?? '',
      x: clampUnit(left / width),
      y: clampUnit(top / height),
      width: clampUnit(w),
      height: clampUnit(h),
    });
  }
  return { space: { width, height }, elements, truncated };
}

/**
 * Keep the SERIALIZED tree within `maxBytes`: drop trailing elements until
 * it fits, and say `truncated`. Element order is the tree's own (top of the
 * hierarchy first), so what survives is the part a person sees first.
 */
export function capAccessibilityTreeBytes(
  tree: DeviceAccessibilityTree,
  maxBytes: number = DEVICE_AX_RESPONSE_MAX_BYTES,
): DeviceAccessibilityTree {
  const bytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes(tree) <= maxBytes) return tree;
  // The frame with no elements, marked truncated, is the fixed overhead.
  let budget = maxBytes - bytes({ ...tree, elements: [], truncated: true });
  const kept: DeviceAccessibilityElement[] = [];
  for (const element of tree.elements) {
    // +1 for the separating comma.
    const cost = bytes(element) + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(element);
  }
  return { ...tree, elements: kept, truncated: true };
}

/** A hub JSON answer, read with a byte ceiling (never an unbounded body). */
async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new DeviceToolsError('hub-unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DeviceToolsError('tool-failed');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DeviceToolsError('tool-failed');
  }
}

// ---- the lease half of authorization ------------------------------------

/** Who, relative to the caller, is driving the device right now. */
export type DeviceControlConflict =
  /** Nobody holds the lease, or the caller itself does (this client). */
  | 'none'
  /** The caller's own principal holds it, from another device or tab. */
  | 'same-person-elsewhere'
  /** Another person, or any agent, holds it. */
  | 'other';

/**
 * Whether someone other than THIS caller — this principal on this client —
 * holds the device's live-surface lease right now, i.e. is actively driving
 * it. Changing a device's settings under them is refused
 * (`device-controlled-by-other`). No open session, or a lease nobody holds
 * (or that has expired), is no conflict. An agent holder is always `other`,
 * whoever it acts for: settings are not a way around the lease.
 *
 * The caller must be a resolved HUMAN caller; the route refuses an
 * unresolved one (`principal-unresolved`) before it gets here.
 */
export function deviceControlConflict(
  deps: {
    sessions: {
      forDevice(
        platform: MobileDevicePlatform,
        deviceId: string,
      ): { surfaceId: string } | undefined;
    };
    surfaces: {
      get(surfaceId: string):
        | {
            lease: {
              snapshot(): {
                holder:
                  | { kind: 'human'; principal: string; device?: string }
                  | { kind: 'agent'; principal: string; sessionId: string }
                  | null;
              };
            };
          }
        | undefined;
    };
  },
  platform: MobileDevicePlatform,
  deviceId: string,
  caller: { principal: string; device: string },
): DeviceControlConflict {
  const session = deps.sessions.forDevice(platform, deviceId);
  if (!session) return 'none';
  const entry = deps.surfaces.get(session.surfaceId);
  if (!entry) return 'none';
  const holder = entry.lease.snapshot().holder;
  if (!holder) return 'none';
  if (holder.kind !== 'human' || holder.principal !== caller.principal)
    return 'other';
  return holder.device === caller.device ? 'none' : 'same-person-elsewhere';
}

// ---- the service --------------------------------------------------------

export interface DeviceToolRunner {
  run(
    tool: DeviceTool,
    args: readonly string[],
    options: { timeoutMs: number; stdin?: string; maxBuffer?: number },
  ): Promise<string>;
}

/** The host runner: finds `xcrun` (macOS) and `adb`, runs with no shell. */
export function createDeviceToolRunner(
  options: {
    locate?: (tool: DeviceTool) => Promise<string | null>;
    run?: typeof runBoundedToolCapture;
  } = {},
): DeviceToolRunner {
  const locate =
    options.locate ??
    ((tool: DeviceTool) =>
      tool === 'xcrun'
        ? process.platform === 'darwin'
          ? locateExecutable('xcrun', ['/usr/bin'])
          : Promise.resolve(null)
        : locateExecutable('adb', standardAdbDirs()));
  const run = options.run ?? runBoundedToolCapture;
  return {
    async run(tool, args, runOptions) {
      const command = await locate(tool);
      if (!command)
        throw new DeviceToolError(
          'tool-unavailable',
          `${tool} is not installed`,
        );
      return run(command, args, runOptions);
    },
  };
}

export interface DeviceToolsTarget {
  /**
   * The device host (#1973). This service runs THIS machine's `xcrun`/`adb`
   * and reads the hub it was given, so it serves exactly one host: a target
   * naming any other is refused before anything runs.
   */
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}

export interface DeviceToolsServiceOptions {
  /**
   * The one device host whose devices this runner and hub reach (default
   * `local`). A tool is never run for a device on another host — above all
   * not against a local device that happens to share its id.
   */
  hostId?: string;
  runner: DeviceToolRunner;
  hub: Pick<DeviceHubEndpoint, 'connect'>;
  now?: () => number;
  /** Per tool invocation. Default 10 s. */
  timeoutMs?: number;
}

const DUMPSYS_MAX_BUFFER = 8 * 1024 * 1024;
const AX_MAX_BYTES = 8 * 1024 * 1024;

function unreadable(reason: DeviceToolsUnreadableReason) {
  return { state: 'unreadable' as const, reason };
}

function reasonOf(error: unknown): DeviceToolsUnreadableReason {
  if (error instanceof DeviceToolsError) {
    switch (error.code) {
      case 'unsupported':
      case 'tool-unavailable':
      case 'tool-failed':
      case 'tool-timeout':
      case 'hub-unavailable':
        return error.code;
      default:
        return 'tool-failed';
    }
  }
  return 'tool-failed';
}

export class DeviceToolsService {
  /** What THIS Station last set, per device (iOS cannot read location). */
  private readonly lastLocation = new Map<
    string,
    { value: DeviceLocation | null; setAt: string }
  >();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  private readonly hostId: string;

  constructor(private readonly options: DeviceToolsServiceOptions) {
    this.hostId = options.hostId ?? 'local';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run one argument vector. The ONLY path to the runner: a vector outside
   * {@link DEVICE_TOOL_ARGV_SHAPES} is refused here, before anything runs.
   */
  private async exec(
    tool: DeviceTool,
    args: readonly string[],
    options: { stdin?: string; maxBuffer?: number } = {},
  ): Promise<string> {
    if (!isAllowedDeviceToolArgv(tool, args))
      throw new DeviceToolsError('invalid-request');
    try {
      return await this.options.runner.run(tool, args, {
        timeoutMs: this.timeoutMs,
        ...options,
      });
    } catch (error) {
      if (error instanceof DeviceToolsError) throw error;
      if (error instanceof DeviceToolError)
        throw new DeviceToolsError(error.code);
      throw new DeviceToolsError('tool-failed');
    }
  }

  private async hubJson(path: string, maxBytes: number): Promise<unknown> {
    let connected: Awaited<ReturnType<DeviceHubEndpoint['connect']>>;
    try {
      connected = await this.options.hub.connect();
    } catch {
      throw new DeviceToolsError('hub-unavailable');
    }
    if (!connected.ok) throw new DeviceToolsError('hub-unavailable');
    let response: Response;
    try {
      response = await connected.connection.request('GET', path, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DeviceToolsError('hub-unavailable');
    }
    return readBoundedJson(response, maxBytes);
  }

  /** Refuse a device on any host but this service's own (#1973). */
  private assertOwnHost(target: DeviceToolsTarget): void {
    if (target.hostId !== this.hostId)
      throw new DeviceToolsError('unsupported');
  }

  private key(target: DeviceToolsTarget): string {
    return `${target.platform}:${target.deviceId}`;
  }

  private async readForeground(
    target: DeviceToolsTarget,
  ): Promise<DeviceReadBack<{ appId: string } | null>> {
    try {
      const value =
        target.platform === 'ios'
          ? parseIosForeground(
              await this.hubJson(
                `/vendor/serve-sim/helper/${target.deviceId}/foreground`,
                64 * 1024,
              ),
            )
          : parseAndroidForeground(
              await this.exec(
                'adb',
                deviceToolArgv.androidDumpsys(target.deviceId, 'window'),
                { maxBuffer: DUMPSYS_MAX_BUFFER },
              ),
            );
      return value === undefined
        ? unreadable('not-reported')
        : { state: 'read', value };
    } catch (error) {
      return unreadable(reasonOf(error));
    }
  }

  private async readAppearance(
    target: DeviceToolsTarget,
  ): Promise<DeviceReadBack<DeviceAppearance>> {
    try {
      const value =
        target.platform === 'ios'
          ? parseIosAppearance(
              await this.exec(
                'xcrun',
                deviceToolArgv.iosAppearance(target.deviceId),
              ),
            )
          : parseAndroidNight(
              await this.exec(
                'adb',
                deviceToolArgv.androidNight(target.deviceId),
              ),
            );
      return value ? { state: 'read', value } : unreadable('not-reported');
    } catch (error) {
      return unreadable(reasonOf(error));
    }
  }

  private async readLocation(
    target: DeviceToolsTarget,
  ): Promise<DeviceLocationReadBack> {
    const lastSet = this.lastLocation.get(this.key(target));
    const fallback = (reason: DeviceToolsUnreadableReason) =>
      lastSet
        ? ({ state: 'last-set', ...lastSet } as const)
        : unreadable(reason);
    // simctl can set and clear a simulated location but never report one.
    if (target.platform === 'ios') return fallback('unsupported');
    try {
      const value = parseAndroidLocation(
        await this.exec(
          'adb',
          deviceToolArgv.androidDumpsys(target.deviceId, 'location'),
          { maxBuffer: DUMPSYS_MAX_BUFFER },
        ),
      );
      return value ? { state: 'read', value } : fallback('not-reported');
    } catch (error) {
      return fallback(reasonOf(error));
    }
  }

  /** Every value the drawer shows, read back from the device now. */
  async snapshot(target: DeviceToolsTarget): Promise<DeviceToolsSnapshot> {
    this.assertOwnHost(target);
    assertTarget(target.platform, target.deviceId);
    const [foregroundApp, appearance, location] = await Promise.all([
      this.readForeground(target),
      this.readAppearance(target),
      this.readLocation(target),
    ]);
    return {
      hostId: 'local',
      platform: target.platform,
      deviceId: target.deviceId,
      readAt: new Date(this.now()).toISOString(),
      foregroundApp,
      appearance,
      location,
      capabilities: deviceToolsCapabilities(target.platform),
    };
  }

  /** One app's permissions, read back (Android; iOS cannot report them). */
  async permissions(
    target: DeviceToolsTarget,
    appId: string,
  ): Promise<DevicePermissionsReadBack> {
    this.assertOwnHost(target);
    assertTarget(target.platform, target.deviceId);
    assertAppId(appId);
    if (target.platform === 'ios')
      return { appId, permissions: unreadable('unsupported') };
    try {
      const parsed = parseAndroidPermissions(
        await this.exec(
          'adb',
          deviceToolArgv.androidDumpsysPackage(target.deviceId, appId),
          { maxBuffer: DUMPSYS_MAX_BUFFER },
        ),
        appId,
      );
      return {
        appId,
        permissions: parsed
          ? { state: 'read', value: parsed }
          : unreadable('not-reported'),
      };
    } catch (error) {
      return { appId, permissions: unreadable(reasonOf(error)) };
    }
  }

  /**
   * The accessibility tree, normalised for the overlay. On Android each read
   * makes serve-emu run `uiautomator dump` on the emulator (a full UI
   * hierarchy dump, real work on the device; confirmed in serve-emu 0.10.1's
   * source), which is why the overlay polls only while it is on and
   * visible.
   */
  async accessibility(
    target: DeviceToolsTarget,
  ): Promise<DeviceAccessibilityTree> {
    this.assertOwnHost(target);
    assertTarget(target.platform, target.deviceId);
    const payload = await this.hubJson(
      target.platform === 'ios'
        ? `/vendor/serve-sim/helper/${target.deviceId}/ax`
        : `/vendor/serve-emu/api/accessibility?device=${encodeURIComponent(target.deviceId)}`,
      AX_MAX_BYTES,
    );
    const tree =
      target.platform === 'ios'
        ? flattenIosAccessibility(payload)
        : flattenAndroidAccessibility(payload);
    if (!tree) throw new DeviceToolsError('tool-failed');
    return capAccessibilityTreeBytes({
      ...tree,
      readAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Run one typed action, then read the device back.
   *
   * An action is ONE user decision, and it is atomic with respect to the
   * live-surface lease: the route checks the lease once, before the first
   * command, and the action then runs to the end. An Android permission
   * group is several `pm` commands (e.g. READ_ and WRITE_CONTACTS) for one
   * decision; stopping between them because control changed hands would
   * leave the app half-granted with nothing to say so, which is worse than
   * finishing a change the person was allowed to make when they made it.
   */
  async act(
    target: DeviceToolsTarget,
    action: DeviceToolAction,
  ): Promise<DeviceToolActionResult> {
    this.assertOwnHost(target);
    assertTarget(target.platform, target.deviceId);
    const { platform, deviceId } = target;
    const ios = platform === 'ios';
    switch (action.type) {
      case 'set-appearance':
        if (action.appearance !== 'light' && action.appearance !== 'dark')
          throw new DeviceToolsError('invalid-request');
        await (ios
          ? this.exec(
              'xcrun',
              deviceToolArgv.iosAppearance(deviceId, action.appearance),
            )
          : this.exec(
              'adb',
              deviceToolArgv.androidNight(deviceId, action.appearance),
            ));
        return { action: action.type, snapshot: await this.snapshot(target) };
      case 'set-location': {
        const location = {
          latitude: action.latitude,
          longitude: action.longitude,
        };
        await (ios
          ? this.exec(
              'xcrun',
              deviceToolArgv.iosSetLocation(deviceId, location),
            )
          : this.exec(
              'adb',
              deviceToolArgv.androidSetLocation(deviceId, location),
            ));
        this.lastLocation.set(this.key(target), {
          value: location,
          setAt: new Date(this.now()).toISOString(),
        });
        return { action: action.type, snapshot: await this.snapshot(target) };
      }
      case 'clear-location':
        if (!ios) throw new DeviceToolsError('unsupported');
        await this.exec('xcrun', deviceToolArgv.iosClearLocation(deviceId));
        this.lastLocation.set(this.key(target), {
          value: null,
          setAt: new Date(this.now()).toISOString(),
        });
        return { action: action.type, snapshot: await this.snapshot(target) };
      case 'set-permission': {
        if (ios) {
          await this.exec(
            'xcrun',
            deviceToolArgv.iosPrivacy(
              deviceId,
              action.decision,
              action.permission,
              action.appId,
            ),
          );
        } else {
          // An app need not declare every permission in a group, and `pm`
          // refuses the ones it does not; the read-back below says what
          // actually holds. Only a group where EVERY change failed is an
          // error.
          const commands = deviceToolArgv.androidPermissions(
            deviceId,
            action.decision,
            action.permission,
            action.appId,
          );
          let firstError: unknown;
          let changed = 0;
          for (const args of commands) {
            try {
              await this.exec('adb', args);
              changed += 1;
            } catch (error) {
              firstError ??= error;
            }
          }
          if (changed === 0) throw firstError;
        }
        const [permissions, snapshot] = await Promise.all([
          this.permissions(target, action.appId),
          this.snapshot(target),
        ]);
        return { action: action.type, snapshot, permissions };
      }
      case 'send-push': {
        if (!ios) throw new DeviceToolsError('unsupported');
        const argv = deviceToolArgv.iosPush(deviceId, action.appId);
        const stdin = encodeDevicePushPayload(action.payload);
        await this.exec('xcrun', argv, { stdin });
        return {
          action: action.type,
          snapshot: await this.snapshot(target),
          push: 'sent',
        };
      }
      default:
        throw new DeviceToolsError('invalid-request');
    }
  }
}
