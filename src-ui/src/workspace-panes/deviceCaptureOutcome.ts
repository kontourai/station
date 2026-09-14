import type { MobileDeviceHostFailure } from '@kontourai/station-contracts/mobile-device';
import { MobileDeviceRequestError } from '@kontourai/station-sdk/mobile-device';
import { describeReadFailure } from '../components/state';

/**
 * The Device pane's typed reasons (#1969).
 *
 * Two derivations, both keyed on a fact the server or the transport actually
 * reported — never on matching a sentence. `PullRequestsPanel` is the
 * precedent: the cause comes from the server, and the copy is chosen from it.
 */

export interface DeviceOutcomeCopy {
  title: string;
  description: string;
}

/**
 * Every `MobileDeviceHostFailure` the inventory can carry, with the sentence
 * that names what the reader can do about it.
 *
 * Exhaustive by type, so a seventh literal added to the contract fails to
 * typecheck here rather than falling through to a generic sentence. Each one
 * says something different on purpose: "the host is not configured" and "the
 * host answered with something Station could not read" are different problems
 * with different remedies, and collapsing them would leave a reader with no
 * next step.
 */
export const DEVICE_HOST_FAILURE_COPY: Record<
  MobileDeviceHostFailure,
  DeviceOutcomeCopy
> = {
  'not-configured': {
    title: 'Set up device inspection',
    description:
      'This Station has no device helper configured, so it cannot list simulators or emulators. Point STATION_MOBILE_DEVICE_HUB_URL at a local device helper and restart Station — the setup guide is docs/guides/mobile-device-workspace.md.',
  },
  'invalid-configuration': {
    title: 'The configured device helper address was refused',
    description:
      'Station only accepts a loopback address on a high port — http://127.0.0.1:<port>, and not port 3000 or 3141. Correct STATION_MOBILE_DEVICE_HUB_URL and restart Station.',
  },
  'hub-unavailable': {
    title: 'The device helper did not answer',
    description:
      'Station reached the configured address and got nothing back. Check that the helper is still running, then refresh.',
  },
  'invalid-response': {
    title: 'The device helper answered with something Station could not read',
    description:
      'The reply did not match the shape Station expects, so nothing about the devices on this machine can be shown. A helper version mismatch is the usual cause.',
  },
  'response-too-large': {
    title: 'The device helper sent more than Station will read',
    description:
      'The reply exceeded the size Station accepts and was discarded unread rather than partially trusted.',
  },
  busy: {
    title: 'The device helper is busy',
    description: 'It was already answering another request. Try again shortly.',
  },
};

/** What a refused capture was, derived from its HTTP status and nothing else. */
export type DeviceCaptureRefusalKind =
  | 'access-denied'
  | 'device-gone'
  | 'invalid-target'
  | 'unavailable';

export interface DeviceCaptureOutcome extends DeviceOutcomeCopy {
  kind: DeviceCaptureRefusalKind | 'transport';
  /**
   * Which control this outcome hands the reader. `refresh` re-reads the
   * inventory (the device may be gone); `retry` re-captures; `none` means
   * there is nothing this reader can press — a credential is not something a
   * button fixes.
   */
  action: 'retry' | 'refresh' | 'none';
}

/**
 * The status → refusal map.
 *
 * `MobileDeviceRequestError.status` is the ONLY thing the client surfaces —
 * it carries no server code and no server message, deliberately — so this is
 * the whole observable and the map is written against it.
 *
 * 401 and 403 land together on purpose. The route emits `access-denied` both
 * when the credential lacks `terminal:operate` and when the principal changed
 * between the check and the capture, and a 401 reaches the same place when a
 * credential is absent or rejected. Nothing distinguishes them here, so the
 * copy covers both rather than asserting the scope explanation alone.
 */
export function describeCaptureRefusal(status: number): DeviceCaptureOutcome {
  if (status === 401 || status === 403)
    return {
      kind: 'access-denied',
      title: 'This Station refused the screen capture',
      description:
        'A read-only credential can list devices but not capture their screens. A sign-in that changed since this pane opened has the same effect. Ask whoever runs this Station for capture access, or sign in again.',
      action: 'none',
    };
  if (status === 409)
    return {
      kind: 'device-gone',
      title: 'That device is no longer running',
      description:
        'It stopped, or it is no longer on this machine. Refresh the device list and pick one that is running.',
      action: 'refresh',
    };
  if (status === 400)
    return {
      kind: 'invalid-target',
      title: 'Station would not send that request',
      description:
        'The selected device is not one this Station knows how to address. Refresh the device list and pick another.',
      action: 'refresh',
    };
  return {
    kind: 'unavailable',
    title: 'The capture did not complete',
    description:
      'Station asked the device helper for a frame and did not get one back.',
    action: 'retry',
  };
}

/**
 * The outcome for whatever a failed capture threw.
 *
 * The typed branch comes first; anything that is not a
 * `MobileDeviceRequestError` is a transport failure, and falls to
 * `describeReadFailure` so the sentence is the most specific honest thing
 * available rather than an invented cause.
 */
export function describeCaptureFailure(error: unknown): DeviceCaptureOutcome {
  if (error instanceof MobileDeviceRequestError)
    return describeCaptureRefusal(error.status);
  return {
    kind: 'transport',
    title: 'The capture did not complete',
    description: describeReadFailure(error),
    action: 'retry',
  };
}
