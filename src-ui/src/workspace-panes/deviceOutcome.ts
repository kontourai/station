import type { MobileDeviceHostFailure } from '@kontourai/station-contracts/mobile-device';
import { MobileDeviceRequestError } from '@kontourai/station-sdk/mobile-device';
import { describeReadFailure } from '../components/state';

/**
 * The Device pane's typed reasons (#1969, #1970).
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
    title: 'Set up devices to start a simulator',
    description:
      'Choose Set up devices, or set Device helper URL in Settings › Advanced › Host options and restart Station.',
  },
  'invalid-configuration': {
    title: 'Device helper address refused',
    description:
      'Set Device helper URL in Settings › Advanced › Host options to http://127.0.0.1:<port> (not 3000 or 3141), then restart Station.',
  },
  'hub-unavailable': {
    title: 'Device helper not answering',
    description: 'Check that the helper is running, then refresh.',
  },
  'invalid-response': {
    title: "Device helper reply couldn't be read",
    description:
      'This is usually a helper version mismatch. Update the helper, then refresh.',
  },
  'response-too-large': {
    title: 'Device helper reply too large',
    description: 'Station discarded it unread. Refresh to try again.',
  },
  busy: {
    title: 'Device helper busy',
    description: 'Try again shortly.',
  },
};

/**
 * Why a device action (start, open, close, power off) was refused, from the
 * route's TYPED code when it sent one and from the HTTP status otherwise —
 * never from matching a sentence.
 */
export function describeDeviceActionFailure(
  error: unknown,
  deviceName: string,
): DeviceOutcomeCopy {
  if (!(error instanceof MobileDeviceRequestError))
    return {
      title: 'The device did not respond',
      description: describeReadFailure(error),
    };
  switch (error.code) {
    case 'device-not-running':
      return {
        title: `${deviceName} is not running`,
        description: 'Start it, then open it again.',
      };
    case 'device-unavailable':
      return {
        title: `${deviceName} is no longer available`,
        description:
          'It stopped, or it’s no longer on this computer. Refresh devices and pick one again.',
      };
    case 'hub-unavailable':
    case 'unavailable':
      return {
        title: 'The device helper did not answer',
        description:
          'Check that the device helper is still running, then try again.',
      };
    default:
      break;
  }
  if (error.status === 401 || error.status === 403)
    return {
      title: 'This Station refused that device action',
      description:
        "Only the Station operator, or an admin of a Project this device is shared with, can use it. Starting and powering off devices is the operator's alone.",
    };
  return {
    title: 'The device action did not complete',
    description: describeReadFailure(error),
  };
}
