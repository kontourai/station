/**
 * The Device pane's Tools drawer (#1971, owner decision D10): typed device
 * settings and one-shot actions, each reported with the value READ BACK
 * from the device afterwards, plus the accessibility tree the overlay draws.
 *
 * There is no generic shell anywhere behind these shapes. Every action is
 * one member of {@link DeviceToolAction}, which the server turns into a
 * fixed argument vector for `xcrun simctl` or `adb`.
 *
 * A value is shown only with where it came from:
 * - `read`: the device reported it just now;
 * - `last-set`: the device cannot report it (iOS has no location read), so
 *   this is the last value THIS Station set, and when — never a device
 *   reading;
 * - `unreadable`: nothing is known, and why.
 */
import type { MobileDevicePlatform } from './mobile-device.js';

/** Why a value could not be read, or an action could not run. */
export type DeviceToolsUnreadableReason =
  /** The platform has no way to report (or change) this. */
  | 'unsupported'
  /** The tool answered but did not report this value. */
  | 'not-reported'
  /** `xcrun` or `adb` is not installed on the device's host. */
  | 'tool-unavailable'
  | 'tool-failed'
  | 'tool-timeout'
  /** The device hub did not answer (accessibility, iOS foreground app). */
  | 'hub-unavailable'
  /**
   * SSH device hosts (#2442): the host is running as many tools as it may
   * at once; transient, try again.
   */
  | 'device-host-busy'
  /** ssh could not reach the SSH device host. */
  | 'device-host-unavailable'
  /** The operator has not enabled the hub on that SSH device host. */
  | 'device-host-not-enabled';

export type DeviceReadBack<T> =
  | { state: 'read'; value: T }
  | { state: 'unreadable'; reason: DeviceToolsUnreadableReason };

export type DeviceAppearance = 'light' | 'dark';

export interface DeviceLocation {
  latitude: number;
  longitude: number;
}

/**
 * Location as the drawer can honestly show it. `last-set` is Station's own
 * record of what it last sent (a `null` value: it last CLEARED the
 * location), never a device reading.
 */
export type DeviceLocationReadBack =
  | DeviceReadBack<DeviceLocation>
  | { state: 'last-set'; value: DeviceLocation | null; setAt: string };

/** The permissions the drawer offers, a fixed list. */
export const DEVICE_PERMISSIONS = [
  'camera',
  'microphone',
  'photos',
  'media-library',
  'contacts',
  'calendar',
  'reminders',
  'location',
  'motion',
  'notifications',
] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];

export type DevicePermissionDecision = 'grant' | 'revoke' | 'reset';

export type DevicePermissionState = 'granted' | 'denied' | 'not-requested';

/** What one app holds, read back from the device for one bundle/package. */
export interface DevicePermissionsReadBack {
  appId: string;
  permissions: DeviceReadBack<
    Partial<Record<DevicePermission, DevicePermissionState>>
  >;
}

/** What this device can do from the drawer; the UI hides the rest. */
export interface DeviceToolsCapabilities {
  appearance: boolean;
  location: boolean;
  clearLocation: boolean;
  push: boolean;
  /** The permissions this platform can change. */
  permissions: readonly DevicePermission[];
  permissionDecisions: readonly DevicePermissionDecision[];
  accessibility: boolean;
}

/** Everything the drawer shows, read back from one device. */
export interface DeviceToolsSnapshot {
  /** The device host the values were read on (`local` or an SSH host). */
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
  readAt: string;
  foregroundApp: DeviceReadBack<{ appId: string } | null>;
  appearance: DeviceReadBack<DeviceAppearance>;
  location: DeviceLocationReadBack;
  capabilities: DeviceToolsCapabilities;
}

/** APNs caps a notification payload at 4 KB; `simctl push` inherits it. */
export const DEVICE_PUSH_PAYLOAD_MAX_BYTES = 4096;

/** An iOS bundle id or Android package name: dotted, no shell characters. */
export const DEVICE_APP_ID_MAX_LENGTH = 255;

export type DeviceToolAction =
  | { type: 'set-appearance'; appearance: DeviceAppearance }
  | { type: 'set-location'; latitude: number; longitude: number }
  | { type: 'clear-location' }
  | {
      type: 'set-permission';
      appId: string;
      permission: DevicePermission;
      decision: DevicePermissionDecision;
    }
  | {
      type: 'send-push';
      appId: string;
      /** A JSON object with an `aps` object, at most 4 KB serialized. */
      payload: Record<string, unknown>;
    };

export type DeviceToolActionType = DeviceToolAction['type'];

/**
 * An action's outcome: it ran (the tool exited 0), and the device's state
 * read back afterwards. A push has nothing to read back; `sent` means
 * simctl accepted it, not that the app displayed it.
 */
export interface DeviceToolActionResult {
  action: DeviceToolActionType;
  snapshot: DeviceToolsSnapshot;
  /** Present for `set-permission`: that app's permissions, read back. */
  permissions?: DevicePermissionsReadBack;
  /** Present for `send-push`. */
  push?: 'sent';
}

/**
 * One element of the accessibility tree, normalised to the tree's own
 * screen: 0..1 on both axes of {@link DeviceAccessibilityTree.space}.
 */
export interface DeviceAccessibilityElement {
  id: string;
  label: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceAccessibilityTree {
  /**
   * The size of the screen the elements are normalised to, in the tree's
   * own units (points on iOS, pixels on Android). Its aspect says which way
   * up the tree was reported, which the overlay needs to line it up with a
   * rotated frame.
   */
  space: { width: number; height: number };
  elements: DeviceAccessibilityElement[];
  /** More elements existed than the cap ({@link DEVICE_AX_ELEMENT_LIMIT}). */
  truncated: boolean;
  readAt: string;
}

export const DEVICE_AX_ELEMENT_LIMIT = 500;

/**
 * The most bytes the SERIALIZED tree may take in a response. A tree within
 * the element cap can still be large (a label of escaped control
 * characters is ~6 bytes per character, CJK 3), so the server drops trailing
 * elements until the tree fits and says `truncated`. Clients read the whole
 * envelope with a larger ceiling than this.
 */
export const DEVICE_AX_RESPONSE_MAX_BYTES = 256 * 1024;

/** The ceiling a client reads the accessibility route's whole envelope with. */
export const DEVICE_AX_CLIENT_MAX_BYTES = 512 * 1024;

/**
 * With `device-controlled-by-other`: whether the holder is the caller's own
 * principal on another device or tab, or someone (or some agent) else.
 */
export type DeviceControlHeldBy = 'same-person-elsewhere' | 'other';

/** Typed refusals of the device tools routes. */
export type DeviceToolsFailure =
  | 'invalid-request'
  | 'invalid-target'
  | 'access-denied'
  /**
   * The request is not from a resolvable HUMAN caller (the station-control
   * token, a delegation device): the drawer is a person's tool. Agents drive
   * devices through the live-surface lease, never around it.
   */
  | 'principal-unresolved'
  | 'unavailable'
  | 'payload-too-large'
  /** Someone else (a person or an agent) is driving this device right now. */
  | 'device-controlled-by-other'
  | 'unsupported'
  | 'tool-unavailable'
  | 'tool-failed'
  | 'tool-timeout'
  | 'hub-unavailable'
  /** The path names an SSH device host this Station does not have. */
  | 'unknown-host'
  /** SSH device hosts (#2442): transient, retry (503). */
  | 'device-host-busy'
  | 'device-host-unavailable'
  | 'device-host-not-enabled';
