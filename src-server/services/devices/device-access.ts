/**
 * Who may watch or drive a device (#1970, D5 as amended by D12).
 *
 * D12: devices are host-global and belong to the Station OPERATOR. The
 * operator shares specific devices (by UDID/serial) with specific Projects;
 * only admins/owners of those Projects may view or drive THOSE devices.
 * Contributors and viewers get nothing. Host-level operations — booting and
 * powering off a device — are the operator's alone.
 *
 * The share store and the admission helper live in `device-shares.ts`;
 * `deviceAccessFromShares` adapts them to the predicate below, which is all
 * the device session and live-surface code asks.
 *
 * Every check runs per request, and any error is a refusal.
 */
import type { LiveSurfaceAction } from '@kontourai/station-contracts/live-surface';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import {
  type DeviceAccessDeps,
  DeviceHostBusyError,
  mayUseNamedDevice,
  resolveDeviceCaller,
} from './device-shares.js';

export type DeviceAccessPurpose = 'view' | 'drive';

export interface DeviceAccess {
  /** The request carries Station operator authority. */
  isOperator(request: Request): Promise<boolean>;
  /**
   * The caller has ANY device standing: the operator, or an admin of the
   * `?projectSlug=` Project with at least one device shared with it. Asked
   * before a route touches the host (reading the inventory may start the
   * managed hub), so a caller with no standing starts nothing.
   */
  hasStanding(request: Request, purpose: DeviceAccessPurpose): Promise<boolean>;
  /**
   * Operator → yes. A Project admin/owner → only for a device the operator
   * shared with one of their Projects, on THAT device host (`hostId`, #1973).
   * Everyone else → no.
   */
  mayAccessDevice(
    request: Request,
    platform: MobileDevicePlatform,
    deviceId: string,
    purpose: DeviceAccessPurpose,
    hostId: string,
  ): Promise<boolean>;
}

/**
 * Any throw inside a check is a refusal, never an admission — except a
 * `DeviceHostBusyError`, which is neither: it propagates so the route can
 * answer a retryable 503 instead of a false "access denied" (#1973 D2).
 */
export function failClosedDeviceAccess(access: DeviceAccess): DeviceAccess {
  return {
    isOperator: async (request) => {
      try {
        return (await access.isOperator(request)) === true;
      } catch {
        return false;
      }
    },
    hasStanding: async (request, purpose) => {
      try {
        return (await access.hasStanding(request, purpose)) === true;
      } catch (error) {
        if (error instanceof DeviceHostBusyError) throw error;
        return false;
      }
    },
    mayAccessDevice: async (request, platform, deviceId, purpose, hostId) => {
      try {
        return (
          (await access.mayAccessDevice(
            request,
            platform,
            deviceId,
            purpose,
            hostId,
          )) === true
        );
      } catch (error) {
        // Transient, not a refusal: the route answers 503 (D2).
        if (error instanceof DeviceHostBusyError) throw error;
        return false;
      }
    },
  };
}

/**
 * The live-surface decision for one device session. `view` needs view
 * access to the device; `input` and `control` need drive access (kept
 * separate for a future read-only role). A check with no request (a bare
 * principal) is refused: this layer cannot verify a principal string.
 */
export async function authorizeDeviceSurfaceAction(
  access: DeviceAccess,
  session: {
    hostId: string;
    platform: MobileDevicePlatform;
    deviceId: string;
    isOpen: () => boolean;
  },
  action: LiveSurfaceAction,
  request: Request | undefined,
): Promise<boolean> {
  if (!request || !session.isOpen()) return false;
  return access.mayAccessDevice(
    request,
    session.platform,
    session.deviceId,
    action === 'view' ? 'view' : 'drive',
    session.hostId,
  );
}

/**
 * D12 through the share store (`device-shares.ts`): the operator always; an
 * admin/owner of `?projectSlug=` only for a device shared with that Project.
 * An Android emulator serial is resolved to the AVD it runs (shares are
 * keyed by AVD name), so a share follows the device, not the port.
 */
export function deviceAccessFromShares(deps: DeviceAccessDeps): DeviceAccess {
  return failClosedDeviceAccess({
    isOperator: async (request) =>
      (await deps.authorizeOperator(request)) === true,
    hasStanding: async (request, purpose) =>
      (await resolveDeviceCaller(deps, request, purpose)) !== undefined,
    mayAccessDevice: async (request, platform, deviceId, purpose, hostId) => {
      const caller = await resolveDeviceCaller(deps, request, purpose);
      if (!caller) return false;
      return mayUseNamedDevice(
        deps,
        caller,
        purpose,
        platform,
        deviceId,
        hostId,
      );
    },
  });
}
