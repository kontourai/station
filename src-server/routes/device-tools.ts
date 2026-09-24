import {
  DEVICE_PERMISSIONS,
  type DeviceToolAction,
  type DeviceToolsFailure,
} from '@kontourai/station-contracts/device-tools';
import {
  isMobileDeviceHostId,
  LOCAL_MOBILE_DEVICE_HOST_ID as LOCAL_DEVICE_HOST_ID,
  type MobileDevicePlatform,
} from '@kontourai/station-contracts/mobile-device';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type { DeviceAccess } from '../services/devices/device-access.js';
import {
  type DeviceControlConflict,
  DeviceToolsError,
  type DeviceToolsService,
  isDeviceAppId,
  isDeviceToolsTarget,
} from '../services/devices/device-tools.js';

/**
 * The Device pane's Tools drawer (#1971, D10), under `/api/mobile-devices`:
 *
 * - `GET  /hosts/:hostId/devices/:platform/:deviceId/tools` — the values the
 *   drawer shows, read back from the device (foreground app, appearance,
 *   location) and what this platform supports.
 * - `GET  …/tools/permissions?appId=` — one app's permissions, read back.
 * - `GET  …/tools/accessibility` — the accessibility tree for the overlay.
 * - `POST …/tools/actions` — one typed action (`DeviceToolAction`), then
 *   the device read back.
 *
 * Authorization, per request and per DEVICE (D12), before the host is
 * touched: reads need `view` access and actions need `drive` (the operator,
 * or an admin of a Project the operator shared the device with; a future
 * view-only role reads but never changes anything). An action is also
 * refused (`device-controlled-by-other`) while ANOTHER controller — a
 * person or an agent — holds the device's live-surface lease: settings are
 * a separate control plane from taps, but not a way around someone who is
 * actively driving. The pairing scope for every leaf is the terminal
 * authority (`pairing-route-scopes.ts`): the tree and the foreground app
 * disclose what is on the screen, like a frame.
 *
 * Device hosts (#1973): the path names the host like every device route. The
 * tools run THIS machine's `xcrun`/`adb` and read the local hub, so only
 * `local` is served; a device on an SSH device host is refused
 * `unsupported` (422) before any access check or tool (the service refuses
 * too). Running the tools on that host over ssh is a follow-up.
 */

export interface DeviceToolsRouteOptions {
  isRequestPrincipalCurrent: (request: Request) => boolean;
  access?: DeviceAccess;
  tools?: DeviceToolsService;
  /**
   * The HUMAN caller and the client it acts from — the SAME resolver the
   * live-surface routes use, so "you hold control" means the same thing in
   * both. Null (the station-control token, a delegation device, anything
   * unattributable) is refused as `principal-unresolved` on every route,
   * reads included, like the live-surface view rule: the drawer is a
   * person's tool, and an agent drives a device through the lease or not at
   * all. Absent → every route answers `unavailable`.
   */
  resolveHumanCaller?: (c: Context) => HumanCaller | null;
  /**
   * Who, relative to this caller, holds the device's live-surface lease
   * (`deviceControlConflict`). Absent → every action is refused as
   * `unavailable`: without it the route cannot tell whether someone is
   * driving.
   */
  controlConflict?: (
    caller: HumanCaller,
    platform: MobileDevicePlatform,
    deviceId: string,
    /** The device host (#1973): its own sessions and surfaces. */
    hostId: string,
  ) => DeviceControlConflict;
}

export interface HumanCaller {
  principal: string;
  device: string;
}

/** The whole action body, push payload included, is bounded. */
export const DEVICE_TOOLS_ACTION_MAX_BODY_BYTES = 8 * 1024;

function failure(c: Context, code: DeviceToolsFailure) {
  const status =
    code === 'invalid-request' || code === 'invalid-target'
      ? 400
      : code === 'access-denied' || code === 'principal-unresolved'
        ? 403
        : code === 'device-controlled-by-other'
          ? 409
          : code === 'payload-too-large'
            ? 413
            : code === 'unsupported'
              ? 422
              : code === 'tool-failed'
                ? 502
                : code === 'tool-timeout'
                  ? 504
                  : 503;
  return c.json({ success: false, code }, status);
}

function targetOf(
  c: Context,
): { hostId: string; platform: MobileDevicePlatform; deviceId: string } | null {
  const hostId = c.req.param('hostId') ?? '';
  const platform = c.req.param('platform');
  const deviceId = c.req.param('deviceId') ?? '';
  if (!isMobileDeviceHostId(hostId)) return null;
  if (platform !== 'ios' && platform !== 'android') return null;
  return isDeviceToolsTarget(platform, deviceId)
    ? { hostId, platform, deviceId }
    : null;
}

/** Only `allowed` query keys, each at most once. */
function queryIsClean(c: Context, allowed: readonly string[]): boolean {
  const queries = c.req.queries();
  return Object.entries(queries).every(
    ([key, values]) => allowed.includes(key) && values.length === 1,
  );
}

const PERMISSIONS: readonly string[] = DEVICE_PERMISSIONS;
const DECISIONS = ['grant', 'revoke', 'reset'];

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const present = Object.keys(record);
  return (
    present.length === keys.length && present.every((k) => keys.includes(k))
  );
}

function finiteIn(value: unknown, limit: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit
  );
}

/**
 * The route seam: exactly one well-formed `DeviceToolAction`, no extra
 * keys. The push payload's own bound and shape are checked again where it
 * is encoded (`encodeDevicePushPayload`).
 */
function parseDeviceToolAction(value: unknown): DeviceToolAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'set-appearance':
      return exactKeys(record, ['type', 'appearance']) &&
        (record.appearance === 'light' || record.appearance === 'dark')
        ? { type: 'set-appearance', appearance: record.appearance }
        : null;
    case 'set-location':
      return exactKeys(record, ['type', 'latitude', 'longitude']) &&
        finiteIn(record.latitude, 90) &&
        finiteIn(record.longitude, 180)
        ? {
            type: 'set-location',
            latitude: record.latitude,
            longitude: record.longitude,
          }
        : null;
    case 'clear-location':
      return exactKeys(record, ['type']) ? { type: 'clear-location' } : null;
    case 'set-permission':
      return exactKeys(record, ['type', 'appId', 'permission', 'decision']) &&
        isDeviceAppId(record.appId) &&
        typeof record.permission === 'string' &&
        PERMISSIONS.includes(record.permission) &&
        typeof record.decision === 'string' &&
        DECISIONS.includes(record.decision)
        ? {
            type: 'set-permission',
            appId: record.appId,
            permission:
              record.permission as (typeof DEVICE_PERMISSIONS)[number],
            decision: record.decision as 'grant' | 'revoke' | 'reset',
          }
        : null;
    case 'send-push': {
      const payload = record.payload;
      return exactKeys(record, ['type', 'appId', 'payload']) &&
        isDeviceAppId(record.appId) &&
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
        ? {
            type: 'send-push',
            appId: record.appId,
            payload: payload as Record<string, unknown>,
          }
        : null;
    }
    default:
      return null;
  }
}

export function createDeviceToolsRoutes(options: DeviceToolsRouteOptions) {
  const app = new Hono();
  const { access, tools } = options;

  const stillCurrent = (c: Context) =>
    options.isRequestPrincipalCurrent(c.req.raw);

  const publish = (c: Context, data: unknown) =>
    stillCurrent(c)
      ? c.json({ success: true, data })
      : failure(c, 'access-denied');

  const conflictResponse = (c: Context, heldBy: DeviceControlConflict) =>
    c.json({ success: false, code: 'device-controlled-by-other', heldBy }, 409);

  const run = async (c: Context, work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeviceToolsError) return failure(c, error.code);
      throw error;
    }
  };

  /** Validated target + per-device access, before the host is touched. */
  const admit = async (
    c: Context,
    purpose: 'view' | 'drive',
  ): Promise<
    | {
        ok: true;
        target: {
          hostId: string;
          platform: MobileDevicePlatform;
          deviceId: string;
        };
        caller: HumanCaller;
      }
    | { ok: false; response: Response }
  > => {
    c.header('Cache-Control', 'no-store');
    if (!stillCurrent(c))
      return { ok: false, response: failure(c, 'access-denied') };
    if (!tools || !access || !options.resolveHumanCaller)
      return { ok: false, response: failure(c, 'unavailable') };
    const target = targetOf(c);
    if (!target) return { ok: false, response: failure(c, 'invalid-target') };
    // Before any access check or host call: only a person uses the drawer.
    const caller = options.resolveHumanCaller(c);
    if (!caller)
      return { ok: false, response: failure(c, 'principal-unresolved') };
    // #1973: the tools run THIS machine's xcrun/adb and read the local hub.
    // A device on an SSH device host is refused, typed, before any access
    // check (which could itself reach that host) and before any tool: a
    // tool aimed at a remote device must never run against a local device
    // that shares its id.
    if (target.hostId !== LOCAL_DEVICE_HOST_ID)
      return { ok: false, response: failure(c, 'unsupported') };
    if (
      !(await access.mayAccessDevice(
        c.req.raw,
        target.platform,
        target.deviceId,
        purpose,
        target.hostId,
      ))
    )
      return { ok: false, response: failure(c, 'access-denied') };
    if (!stillCurrent(c))
      return { ok: false, response: failure(c, 'access-denied') };
    return { ok: true, target, caller };
  };

  app.get('/hosts/:hostId/devices/:platform/:deviceId/tools', async (c) => {
    if (!queryIsClean(c, ['projectSlug'])) return failure(c, 'invalid-request');
    const admitted = await admit(c, 'view');
    if (!admitted.ok) return admitted.response;
    return run(c, async () =>
      publish(c, await tools!.snapshot(admitted.target)),
    );
  });

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/permissions',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug', 'appId']))
        return failure(c, 'invalid-request');
      const appId = c.req.query('appId');
      if (!isDeviceAppId(appId)) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      return run(c, async () =>
        publish(c, await tools!.permissions(admitted.target, appId)),
      );
    },
  );

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/accessibility',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      return run(c, async () =>
        publish(c, await tools!.accessibility(admitted.target)),
      );
    },
  );

  app.post(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/actions',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      if (!targetOf(c)) return failure(c, 'invalid-target');
      const body = await readBoundedRequestBody(
        c.req.raw,
        DEVICE_TOOLS_ACTION_MAX_BODY_BYTES,
      );
      if (body.status === 'too-large') return failure(c, 'payload-too-large');
      if (body.status !== 'ok') return failure(c, 'invalid-request');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.body);
      } catch {
        return failure(c, 'invalid-request');
      }
      const action = parseDeviceToolAction(parsed);
      if (!action) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'drive');
      if (!admitted.ok) return admitted.response;
      const { platform, deviceId } = admitted.target;
      if (!options.controlConflict) return failure(c, 'unavailable');
      // Once, before the first command: an action is one decision and runs
      // to the end (see DeviceToolsService.act on why it is atomic).
      const conflict = options.controlConflict(
        admitted.caller,
        platform,
        deviceId,
        admitted.target.hostId,
      );
      if (conflict !== 'none') return conflictResponse(c, conflict);
      return run(c, async () =>
        publish(c, await tools!.act(admitted.target, action)),
      );
    },
  );

  return app;
}
