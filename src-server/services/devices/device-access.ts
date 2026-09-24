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
import { LiveSurfaceAuthorizerBusyError } from '../live-surface/registry.js';
import {
  type DeviceAccessDeps,
  DeviceHostBusyError,
  deviceShareKey,
  mayPerformDeviceAction,
  resolveDeviceCaller,
} from './device-shares.js';

export type DeviceAccessPurpose = 'view' | 'drive';

/**
 * The share key (an Android AVD name, or the device id itself) a check last
 * resolved for ONE open device session (#2433). Every check still resolves
 * the key afresh, and only the fresh key ever admits. The memo decides one
 * thing: what a BUSY host means. When the caller no longer holds a share of
 * the remembered key and the fresh resolve reports the host busy, the check
 * refuses rather than answering busy — so a revoked share ends a stream at
 * once even while the host cannot say which AVD runs. When the fresh
 * resolve answers, its key decides and replaces the memo, so a stale key
 * (the emulator now runs another AVD) refuses nothing once the host answers.
 */
export interface DeviceShareKeyMemo {
  key?: string;
}

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
    shareKeyMemo?: DeviceShareKeyMemo,
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
    mayAccessDevice: async (
      request,
      platform,
      deviceId,
      purpose,
      hostId,
      shareKeyMemo,
    ) => {
      try {
        return (
          (await access.mayAccessDevice(
            request,
            platform,
            deviceId,
            purpose,
            hostId,
            shareKeyMemo,
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
 *
 * A busy device host is neither answer: it is thrown as the live-surface
 * layer's `LiveSurfaceAuthorizerBusyError` (#2433), so the routes answer a
 * retryable 503 and a running stream keeps its last decision. Every other
 * failure has already become a refusal in `failClosedDeviceAccess`.
 */
export async function authorizeDeviceSurfaceAction(
  access: DeviceAccess,
  session: {
    hostId: string;
    platform: MobileDevicePlatform;
    deviceId: string;
    isOpen: () => boolean;
    /** Per-session (#2433): lets a re-check refuse a revoked share while busy. */
    shareKeyMemo?: DeviceShareKeyMemo;
  },
  action: LiveSurfaceAction,
  request: Request | undefined,
): Promise<boolean> {
  if (!request || !session.isOpen()) return false;
  try {
    return await access.mayAccessDevice(
      request,
      session.platform,
      session.deviceId,
      action === 'view' ? 'view' : 'drive',
      session.hostId,
      session.shareKeyMemo,
    );
  } catch (error) {
    if (error instanceof DeviceHostBusyError)
      throw new LiveSurfaceAuthorizerBusyError({ cause: error });
    throw error;
  }
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
    mayAccessDevice: async (
      request,
      platform,
      deviceId,
      purpose,
      hostId,
      shareKeyMemo,
    ) => {
      const caller = await resolveDeviceCaller(deps, request, purpose);
      if (!caller) return false;
      if (caller.kind === 'operator') return true;
      // The remembered key only decides what a BUSY host means: a share
      // already withdrawn refuses then. The fresh key below still admits.
      const known = shareKeyMemo?.key;
      const memoRefuses =
        known !== undefined &&
        !mayPerformDeviceAction(caller, purpose, platform, known, hostId);
      let shareKey: string | undefined;
      try {
        shareKey = await deviceShareKey(deps, platform, deviceId, hostId);
      } catch (error) {
        // Busy is not an answer; with the remembered share already gone,
        // it is not a reason to keep the stream either.
        if (memoRefuses && error instanceof DeviceHostBusyError) return false;
        throw error;
      }
      if (shareKey !== undefined && shareKeyMemo) shareKeyMemo.key = shareKey;
      return mayPerformDeviceAction(
        caller,
        purpose,
        platform,
        shareKey,
        hostId,
      );
    },
  });
}
