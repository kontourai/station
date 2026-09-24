import {
  type DeviceHostSummary,
  isMobileDeviceHostId,
  type MobileDevicePlatform,
  type MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type { DeviceAccess } from '../services/devices/device-access.js';
import {
  DeviceSessionError,
  type DeviceSessionService,
} from '../services/devices/device-session-service.js';
import { DeviceHostBusyError } from '../services/devices/device-shares.js';
import {
  isValidMobileDeviceId,
  type LocalMobileDeviceHost,
  MobileDeviceHostError,
} from '../services/mobile-device/mobile-device-host.js';

/**
 * `/api/mobile-devices/*` (#1969 snapshot, #1970 live sessions).
 *
 * Reads: the device list, the open sessions. Mutations: capture one frame;
 * start (boot) a device; open (or join) a device session, which registers a
 * live surface; close a session (stop watching — the device keeps running);
 * power a device off. Every mutation sits on the terminal authority
 * (`pairing-route-scopes.ts`), and authentication is rechecked after any
 * await that precedes publishing.
 *
 * D12: every route is authorized per caller and per DEVICE BEFORE the host
 * is touched (reading the inventory may start the managed hub): the Station
 * operator, or an admin/owner of the `?projectSlug=` Project the operator
 * shared that device with. The inventory is filtered to the devices the
 * caller may see. Capturing, starting (booting) and opening a session drive
 * the device — a shared admin may; powering off and "End for everyone" are
 * the operator's alone. Without a session service the session routes answer
 * `unavailable`.
 *
 * Device hosts (#1973, D13): every route names its host
 * (`/hosts/:hostId/…`): `local`, or an operator-managed SSH device host.
 * The host is resolved per request; an unknown or malformed id is refused
 * before anything is touched, and every D12 check is made against THAT
 * host's shares. `GET /hosts` lists the hosts for the pane's picker
 * (labels only, never an ssh target) to anyone with device standing.
 */

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One device host's services, as the routes use them. */
export interface MobileDeviceHostServices {
  host: Pick<LocalMobileDeviceHost, 'inventory' | 'capture'>;
  sessions?: DeviceSessionService;
}

export interface MobileDeviceRouteOptions {
  isRequestPrincipalCurrent: (request: Request) => boolean;
  /** The LOCAL host's sessions (the first argument is the local host). */
  sessions?: DeviceSessionService;
  /**
   * Another device host's services, by id (SSH device hosts, #1973), or
   * undefined for a host this Station does not have.
   */
  remoteHost?: (hostId: string) => MobileDeviceHostServices | undefined;
  /** The SSH device hosts for the picker (the local host is always first). */
  listRemoteHosts?: () => DeviceHostSummary[];
  /**
   * D12 device access (`deviceAccessFromShares`). Required: without it no
   * route can tell who may touch which device, so every route refuses.
   */
  access?: DeviceAccess;
}

type SessionFailure =
  | 'invalid-request'
  | 'invalid-target'
  | 'access-denied'
  | 'unavailable'
  | DeviceSessionError['code'];

function refuse(c: Context, code: SessionFailure) {
  const status =
    code === 'invalid-request' || code === 'invalid-target'
      ? 400
      : code === 'access-denied' || code === 'not-authorized'
        ? 403
        : code === 'unknown-session'
          ? 404
          : code === 'device-unavailable' || code === 'device-not-running'
            ? 409
            : 503;
  return c.json({ success: false, code }, status);
}

/** A strict, bounded JSON object body: `{}` or only `allowed` string keys. */
async function readObjectBody(
  request: Request,
  allowed: readonly string[],
): Promise<Record<string, string> | null> {
  const body = await readBoundedRequestBody(request, 1024);
  if (body.status !== 'ok') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!allowed.includes(field) || typeof value !== 'string') return null;
    out[field] = value;
  }
  return out;
}

function targetOf(c: Context): MobileDeviceTarget | null {
  const platform = c.req.param('platform');
  const hostId = c.req.param('hostId') ?? '';
  if (platform !== 'ios' && platform !== 'android') return null;
  if (!isMobileDeviceHostId(hostId)) return null;
  const deviceId = c.req.param('deviceId') ?? '';
  // The host id is the route's own (validated above); only the device id
  // is left to check.
  return isValidMobileDeviceId(platform, deviceId)
    ? { hostId, platform: platform as MobileDevicePlatform, deviceId }
    : null;
}

export function createMobileDeviceRoutes(
  localHost: Pick<LocalMobileDeviceHost, 'inventory' | 'capture'>,
  options: MobileDeviceRouteOptions,
) {
  const app = new Hono();
  // A device host too busy to say which AVD an emulator runs is transient:
  // 503, never an authorization refusal (#1973 D2).
  app.onError((error, c) => {
    if (error instanceof DeviceHostBusyError)
      return c.json({ success: false, code: 'device-host-busy' }, 503);
    throw error;
  });
  /** The named host's services; undefined for a malformed or unknown id. */
  const hostServices = (
    hostId: string | undefined,
  ): MobileDeviceHostServices | undefined => {
    if (!isMobileDeviceHostId(hostId)) return undefined;
    if (hostId === 'local')
      return {
        host: localHost,
        ...(options.sessions ? { sessions: options.sessions } : {}),
      };
    return options.remoteHost?.(hostId);
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    await next();
  });
  // The pane's host picker: `local`, then each SSH device host (labels only).
  app.get('/hosts', async (c) => {
    const access = options.access;
    if (!access || !(await access.hasStanding(c.req.raw, 'view')))
      return c.json({ success: false, code: 'access-denied' }, 403);
    const hosts: DeviceHostSummary[] = [
      { hostId: 'local', label: 'This Station', kind: 'local' },
      ...(options.listRemoteHosts?.() ?? []),
    ];
    // A non-operator is not told a remote hub's state.
    const operator = await access.isOperator(c.req.raw);
    const data = operator
      ? hosts
      : hosts.map(({ hostId, label, kind }) => ({ hostId, label, kind }));
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    return c.json({ success: true, data: { hosts: data } });
  });
  app.get('/hosts/:hostId/devices', async (c) => {
    const access = options.access;
    const hostId = c.req.param('hostId');
    // D12: a caller with no device standing learns nothing and starts
    // nothing — refused before the host (and so the managed hub) is touched.
    if (!access || !(await access.hasStanding(c.req.raw, 'view')))
      return c.json({ success: false, code: 'access-denied' }, 403);
    const services = hostServices(hostId);
    if (!services) return c.json({ success: false, code: 'unknown-host' }, 404);
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    const host = services.host;
    const sessionsForHost = services.sessions;
    const data = await host.inventory();
    // A Start in flight keeps its device listed while the hub cannot say
    // where it is (an emulator between its AVD row and its serial row).
    if (options.sessions && data.state !== 'unavailable')
      data.devices = options.sessions.withStartingRows(data.devices);
    // A non-operator sees only the devices shared with them, and is told
    // it may not power off or end sessions for everyone.
    const operator = await access.isOperator(c.req.raw);
    data.canManageDevices = operator;
    if (!operator) {
      const shared = [];
      for (const device of data.devices)
        if (
          await access.mayAccessDevice(
            c.req.raw,
            device.platform,
            device.deviceId,
            'view',
            hostId,
          )
        )
          shared.push(device);
      data.devices = shared;
    }
    if (sessionsForHost)
      for (const device of data.devices) {
        if (sessionsForHost.isStarting(device.platform, device.deviceId))
          device.starting = true;
        const startError = sessionsForHost.startFailure(
          device.platform,
          device.deviceId,
        );
        if (startError) device.startError = startError;
      }
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    return c.json({ success: true, data });
  });
  app.post('/hosts/:hostId/devices/:platform/:deviceId/capture', async (c) => {
    const platform = c.req.param('platform');
    const hostId = c.req.param('hostId');
    if (platform !== 'ios' && platform !== 'android')
      return c.json({ success: false, code: 'invalid-target' }, 400);
    const services = hostServices(hostId);
    if (!services)
      return c.json({ success: false, code: 'invalid-target' }, 400);
    const body = await readBoundedRequestBody(c.req.raw, 1024);
    if (body.status !== 'ok')
      return c.json({ success: false, code: 'invalid-request' }, 400);
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length
      )
        return c.json({ success: false, code: 'invalid-request' }, 400);
    } catch {
      return c.json({ success: false, code: 'invalid-request' }, 400);
    }
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    // D12: a capture POSTs a screenshot on the hub, which drives THIS
    // device (the hub route table marks it `drive`).
    if (
      !options.access ||
      !(await options.access.mayAccessDevice(
        c.req.raw,
        platform as MobileDevicePlatform,
        c.req.param('deviceId'),
        'drive',
        hostId,
      ))
    )
      return c.json({ success: false, code: 'access-denied' }, 403);
    try {
      const data = await services.host.capture({
        hostId,
        platform: platform as MobileDevicePlatform,
        deviceId: c.req.param('deviceId'),
      });
      if (!options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, code: 'access-denied' }, 403);
      return c.json({ success: true, data });
    } catch (error) {
      if (!(error instanceof MobileDeviceHostError)) throw error;
      const status =
        error.code === 'invalid-target'
          ? 400
          : error.code === 'device-unavailable'
            ? 409
            : 503;
      return c.json({ success: false, code: error.code }, status);
    }
  });

  // ---- live device sessions (#1970) ---------------------------------------

  const { access } = options;
  /** The named host's session service, or undefined (refused as unavailable). */
  const sessionsFor = (c: Context) =>
    hostServices(c.req.param('hostId'))?.sessions;

  /** Publish only if the credential is still current after the awaits. */
  const publish = (c: Context, data: unknown) =>
    options.isRequestPrincipalCurrent(c.req.raw)
      ? c.json({ success: true, data })
      : refuse(c, 'access-denied');

  const run = async (c: Context, work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeviceSessionError) return refuse(c, error.code);
      throw error;
    }
  };

  app.get('/hosts/:hostId/sessions', async (c) => {
    const sessions = sessionsFor(c);
    if (!sessions || !access) return refuse(c, 'unavailable');
    const visible = [];
    for (const session of sessions.list())
      if (
        await access.mayAccessDevice(
          c.req.raw,
          session.platform,
          session.deviceId,
          'view',
          session.hostId,
        )
      )
        visible.push(session);
    return publish(c, { sessions: visible });
  });

  /**
   * The credential is re-checked AFTER the access checks and BEFORE any
   * side effect: a sign-in withdrawn while those awaited must not boot,
   * open or power off anything.
   */
  const stillCurrent = (c: Context) =>
    options.isRequestPrincipalCurrent(c.req.raw);

  app.post('/hosts/:hostId/devices/:platform/:deviceId/start', async (c) => {
    const sessions = sessionsFor(c);
    if (!sessions || !access) return refuse(c, 'unavailable');
    const target = targetOf(c);
    if (!target) return refuse(c, 'invalid-target');
    if (!(await readObjectBody(c.req.raw, [])))
      return refuse(c, 'invalid-request');
    // D12: booting drives THIS device — the operator, or an admin of a
    // Project it is shared with (the hub's boot route is `drive`).
    if (
      !(await access.mayAccessDevice(
        c.req.raw,
        target.platform,
        target.deviceId,
        'drive',
        target.hostId,
      ))
    )
      return refuse(c, 'access-denied');
    if (!stillCurrent(c)) return refuse(c, 'access-denied');
    return run(c, async () => {
      const result = await sessions.start(target);
      if (!stillCurrent(c)) return refuse(c, 'access-denied');
      // A cold boot takes minutes: 202 and a `starting` state; the caller
      // polls the device list rather than holding a request open.
      return c.json(
        { success: true, data: result },
        result.state === 'starting' ? 202 : 200,
      );
    });
  });

  app.post('/hosts/:hostId/devices/:platform/:deviceId/sessions', async (c) => {
    const sessions = sessionsFor(c);
    if (!sessions || !access) return refuse(c, 'unavailable');
    const target = targetOf(c);
    if (!target) return refuse(c, 'invalid-target');
    if (!(await readObjectBody(c.req.raw, [])))
      return refuse(c, 'invalid-request');
    // D12: access to THIS device (operator, or an admin of a Project it
    // was shared with). Opening may attach the simulator's stream helper and
    // hands the caller the input channel, so it needs `drive`; under D12 a
    // shared admin holds view and drive together, so joining is no different.
    if (
      !(await access.mayAccessDevice(
        c.req.raw,
        target.platform,
        target.deviceId,
        'drive',
        target.hostId,
      ))
    )
      return refuse(c, 'access-denied');
    if (!stillCurrent(c)) return refuse(c, 'access-denied');
    return run(c, async () =>
      publish(c, await sessions.open(target, () => stillCurrent(c))),
    );
  });

  // "End for everyone": the operator's. Closing one pane only detaches that
  // viewer; a session nobody watches ends by itself (DeviceSessionService).
  app.delete('/hosts/:hostId/sessions/:sessionId', async (c) => {
    const sessions = sessionsFor(c);
    if (!sessions || !access) return refuse(c, 'unavailable');
    const sessionId = c.req.param('sessionId');
    if (!SESSION_ID.test(sessionId)) return refuse(c, 'invalid-request');
    // Access BEFORE existence: a non-operator learns nothing about which
    // session ids exist (403 whether or not it does).
    if (!(await access.isOperator(c.req.raw)))
      return refuse(c, 'access-denied');
    if (!sessions.get(sessionId)) return refuse(c, 'unknown-session');
    if (!stillCurrent(c)) return refuse(c, 'access-denied');
    return run(c, async () =>
      publish(c, { closed: await sessions.close(sessionId) }),
    );
  });

  app.post(
    '/hosts/:hostId/devices/:platform/:deviceId/power-off',
    async (c) => {
      const sessions = sessionsFor(c);
      if (!sessions || !access) return refuse(c, 'unavailable');
      const target = targetOf(c);
      if (!target) return refuse(c, 'invalid-target');
      if (!(await readObjectBody(c.req.raw, [])))
        return refuse(c, 'invalid-request');
      if (!(await access.isOperator(c.req.raw)))
        return refuse(c, 'access-denied');
      if (!stillCurrent(c)) return refuse(c, 'access-denied');
      return run(c, async () => {
        await sessions.powerOff(target);
        return publish(c, { poweredOff: true });
      });
    },
  );

  return app;
}
