/**
 * Managed device toolchain routes and the device hub proxy (#1970, D11).
 * Mounted under `/api/mobile-devices` ONLY on personal Station hosts (the
 * same gate as the rest of that family); hosted deployments never mount it.
 *
 * Authorization (D5, D12): every request needs a current principal.
 * Devices belong to the operator. Toolchain reads and the hub proxy admit the
 * operator, or an admin/owner of the Project named by `?projectSlug=` that
 * has devices shared with it — and the proxy admits that admin only for a
 * route naming one of those shared devices. Every toolchain mutation
 * (enabling the hub, agent access, updates, starting the hub) and every
 * share change is operator-only: it installs software onto, runs a process
 * on, or hands out a device of the Station host. An admin opening a shared
 * device may still cause the managed hub to START, but only after the
 * operator enabled it (that enablement is the consent). Pairing scopes sit
 * in `pairing-route-scopes.ts` (reads at `orchestration:read`, mutations and
 * the whole proxy at `terminal:operate`, matching frame capture).
 * Validation lives here, at the route seam.
 *
 * Device hosts (#1973): a share names its host (`hostId`, default `local`
 * for requests written before hosts existed), and the hub proxy is
 * `/hosts/:hostId/hub/*` — an SSH device host's forwarded hub through the
 * same allowlist, the same D12 check against THAT host's shares.
 */
import type {
  DeviceToolchainStatus,
  DeviceToolId,
  DeviceToolState,
} from '@kontourai/station-contracts/device-toolchain';
import { isMobileDeviceHostId } from '@kontourai/station-contracts/mobile-device';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import { isValidBrowserProjectId } from '../services/browser/browser-session-registry.js';
import {
  type DeviceAccessDeps,
  type DeviceCaller,
  DeviceHostBusyError,
  DeviceShareError,
  type DeviceShareStore,
  deviceShareKey,
  mayUseNamedDevice,
  resolveDeviceCaller,
} from '../services/devices/device-shares.js';
import {
  type DeviceHubConnection,
  DeviceHubPathRefusedError,
  hubRouteDevice,
  matchHubClientRoute,
} from '../services/devices/toolchain/device-hub-connection.js';
import { DeviceToolConsentRequiredError } from '../services/devices/toolchain/device-toolchain.js';
import {
  type DeviceToolchainService,
  DeviceToolNotConsentedError,
} from '../services/devices/toolchain/device-toolchain-service.js';
import { isValidMobileDeviceId } from '../services/mobile-device/mobile-device-host.js';

const MAX_BODY_BYTES = 16 * 1024;
const HUB_PATH = /^\/hosts\/([^/]+)\/hub(\/.*)$/;
const TOOLS: readonly DeviceToolId[] = ['expo-device-hub', 'agent-device'];
/** Request headers a hub route may read. Credentials and cookies never cross. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'range'];
/** Response headers the client may see from the hub. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
];

export interface DeviceToolchainRoutesDeps {
  service: Pick<
    DeviceToolchainService,
    | 'status'
    | 'versions'
    | 'enableHub'
    | 'disableHub'
    | 'setAgentAccess'
    | 'update'
    | 'startHub'
    | 'ensureHub'
  >;
  /** D12: operator, Project admin authorizers and the share list. */
  access: DeviceAccessDeps;
  shares: Pick<DeviceShareStore, 'list' | 'add' | 'remove'>;
  /** Every Project (canonical ID and current slug), for the share list. */
  listProjects(): Array<{ id: string; slug: string }>;
  isRequestPrincipalCurrent(request: Request): boolean;
  /**
   * An SSH device host's hub (#1973): whether the id names a stored host,
   * and its running connection (started on demand once the operator
   * enabled it). Absent: only `local` exists.
   */
  remoteHubs?: {
    has(hostId: string): boolean;
    ensureHub(hostId: string): Promise<DeviceHubConnection | undefined>;
  };
  /** Admins' concurrent video streams (defaults 4 per caller, 8 per Project). */
  streamLimits?: { perCaller: number; perProject: number };
}

/** Response content types the proxy passes; anything else is opaque bytes. */
const PASSED_CONTENT_TYPES = [
  /^image\/(png|jpeg|webp)(;|$)/i,
  /^multipart\/x-mixed-replace(;|$)/i,
  /^application\/json(;|$)/i,
  /^text\/plain(;|$)/i,
];

function safeContentType(value: string | null): string {
  return value !== null &&
    PASSED_CONTENT_TYPES.some((pattern) => pattern.test(value))
    ? value
    : 'application/octet-stream';
}

const STREAM_PATH = /\/(stream\.mjpeg|stream\.avcc)$/;

/**
 * Status as a non-operator may see it: states and versions, never the
 * failure detail text (it can name host paths and command output).
 */
function redactStatus(
  status: DeviceToolchainStatus,
  caller: DeviceCaller,
): DeviceToolchainStatus {
  if (caller.kind === 'operator') return { ...status, canManage: true };
  const tool = (state: DeviceToolState): DeviceToolState =>
    state.state === 'failed' ? { ...state, detail: '' } : state;
  return {
    ...status,
    canManage: false,
    hub: tool(status.hub),
    agentDevice: tool(status.agentDevice),
    hubProcess:
      status.hubProcess.state === 'crashed'
        ? { ...status.hubProcess, detail: '' }
        : status.hubProcess,
    platforms: [],
  };
}

async function readJsonObject(
  request: Request,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body.status !== 'ok') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body === '' ? '{}' : body.body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  if (Object.keys(parsed).some((key) => !allowedKeys.includes(key)))
    return undefined;
  return parsed as Record<string, unknown>;
}

export function createDeviceToolchainRoutes(deps: DeviceToolchainRoutesDeps) {
  const app = new Hono();
  // Transient host busy (#1973 D2): 503, never 403.
  app.onError((error, c) => {
    if (error instanceof DeviceHostBusyError)
      return c.json({ success: false, code: 'device-host-busy' }, 503);
    throw error;
  });
  const denied = { success: false, code: 'access-denied' } as const;
  const invalid = { success: false, code: 'invalid-request' } as const;
  const consentRequired = { success: false, code: 'consent-required' } as const;

  const isOperator = (request: Request) =>
    deps.access.authorizeOperator(request);
  /** `local`, or an SSH device host this Station has. */
  const knownHost = (hostId: string) =>
    hostId === 'local' ||
    (isMobileDeviceHostId(hostId) && deps.remoteHubs?.has(hostId) === true);
  // Project admins' concurrent video streams, per caller and per Project.
  // The operator is never capped: an admin's streams must not lock the
  // owner of the devices out of them.
  const perCallerStreams = deps.streamLimits?.perCaller ?? 4;
  const perProjectStreams = deps.streamLimits?.perProject ?? 8;
  const openStreams = new Map<string, number>();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    await next();
  });

  app.get('/toolchain', async (c) => {
    const caller = await resolveDeviceCaller(deps.access, c.req.raw, 'view');
    if (!caller) return c.json(denied, 403);
    const data = redactStatus(await deps.service.status(), caller);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data });
  });

  // Read-only: reports running/required/installed and starts nothing.
  app.get('/toolchain/versions', async (c) => {
    if (!(await resolveDeviceCaller(deps.access, c.req.raw, 'view')))
      return c.json(denied, 403);
    return c.json({ success: true, data: deps.service.versions() });
  });

  // D12 shares. The operator sees every Project's; an admin sees their own.
  app.get('/shares', async (c) => {
    const caller = await resolveDeviceCaller(deps.access, c.req.raw, 'view');
    if (!caller) return c.json(denied, 403);
    const projects =
      caller.kind === 'operator'
        ? deps.listProjects()
        : deps.listProjects().filter((p) => p.id === caller.projectId);
    const data = projects
      .map((project) => ({
        projectId: project.id,
        projectSlug: project.slug,
        shares: deps.shares.list(project.id),
      }))
      .filter((entry) => caller.kind === 'operator' || entry.shares.length);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data });
  });

  // The AVD running on each named emulator serial, for the operator's share
  // list: running emulators are listed by serial, shares are keyed by AVD.
  app.get('/shares/avds', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const params = new URL(c.req.url).searchParams;
    const serials = params.getAll('serial');
    const hostId = params.get('hostId') ?? 'local';
    if (
      !knownHost(hostId) ||
      serials.length > 32 ||
      serials.some((serial) => !/^emulator-[0-9]{1,5}$/.test(serial))
    )
      return c.json(invalid, 400);
    const data: Record<string, string | null> = {};
    for (const serial of new Set(serials))
      data[serial] =
        (await deviceShareKey(deps.access, 'android', serial, hostId)) ?? null;
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data });
  });

  app.post('/shares', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, [
      'projectSlug',
      'hostId',
      'platform',
      'deviceId',
      'label',
    ]);
    if (!body || !isValidBrowserProjectId(body.projectSlug))
      return c.json(invalid, 400);
    // Absent: a local share, as every share was before device hosts.
    const hostId = body.hostId === undefined ? 'local' : body.hostId;
    if (typeof hostId !== 'string' || !knownHost(hostId))
      return c.json(invalid, 400);
    const project = deps.access.resolveProject(body.projectSlug);
    if (!project) return c.json(invalid, 400);
    // A running emulator is listed by serial; the share is recorded under
    // the AVD running there now (a serial follows the port, not the AVD).
    const deviceId =
      body.platform === 'android' && typeof body.deviceId === 'string'
        ? await deviceShareKey(deps.access, 'android', body.deviceId, hostId)
        : body.deviceId;
    if (deviceId === undefined)
      return c.json({ success: false, code: 'device-unavailable' }, 409);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      const share = deps.shares.add(
        project.id,
        {
          hostId,
          platform: body.platform,
          deviceId,
          label: body.label,
        },
        'operator',
      );
      return c.json({ success: true, data: share }, 201);
    } catch (error) {
      if (error instanceof DeviceShareError)
        return c.json(
          { success: false, code: error.code },
          error.code === 'duplicate' ? 409 : 400,
        );
      throw error;
    }
  });

  app.delete('/shares/:projectSlug/:platform/:deviceId', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const slug = c.req.param('projectSlug');
    const project = isValidBrowserProjectId(slug)
      ? deps.access.resolveProject(slug)
      : undefined;
    if (!project) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const platform = c.req.param('platform');
    // `?hostId=` names the host; absent is `local` (older clients).
    const hostId = new URL(c.req.url).searchParams.get('hostId') ?? 'local';
    if (!isMobileDeviceHostId(hostId)) return c.json(invalid, 400);
    const deviceId = await deviceShareKey(
      deps.access,
      platform,
      c.req.param('deviceId'),
      hostId,
    );
    if (deviceId === undefined)
      return c.json({ success: false, code: 'not-found' }, 404);
    try {
      deps.shares.remove(project.id, platform, deviceId, hostId);
    } catch (error) {
      if (error instanceof DeviceShareError)
        return c.json({ success: false, code: error.code }, 404);
      throw error;
    }
    return c.json({ success: true, data: { removed: true } });
  });

  app.post('/toolchain/hub', async (c) => {
    // Authorization first: a non-operator learns nothing about the body.
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['enabled', 'consent']);
    if (!body || typeof body.enabled !== 'boolean') return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    if (!body.enabled) {
      await deps.service.disableHub();
      return c.json({ success: true, data: await deps.service.status() });
    }
    // Consent is the literal `true`; nothing else starts an install.
    if (body.consent !== true) return c.json(consentRequired, 400);
    try {
      deps.service.enableHub({ consent: true });
    } catch (error) {
      if (error instanceof DeviceToolConsentRequiredError)
        return c.json(consentRequired, 400);
      throw error;
    }
    return c.json({ success: true, data: await deps.service.status() }, 202);
  });

  app.post('/toolchain/agent-access', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['enabled', 'consent']);
    if (!body || typeof body.enabled !== 'boolean') return c.json(invalid, 400);
    if (body.enabled && body.consent !== true)
      return c.json(consentRequired, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      deps.service.setAgentAccess(
        body.enabled,
        body.enabled ? { consent: true } : undefined,
      );
    } catch (error) {
      if (error instanceof DeviceToolConsentRequiredError)
        return c.json(consentRequired, 400);
      throw error;
    }
    return c.json(
      { success: true, data: await deps.service.status() },
      body.enabled ? 202 : 200,
    );
  });

  app.post('/toolchain/update', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['tool']);
    const tool = TOOLS.find((candidate) => candidate === body?.tool);
    if (!tool) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      deps.service.update(tool);
    } catch (error) {
      if (error instanceof DeviceToolNotConsentedError)
        return c.json({ success: false, code: 'not-set-up' }, 409);
      throw error;
    }
    return c.json({ success: true, data: await deps.service.status() }, 202);
  });

  // Start the managed hub, or start it again after it crashed.
  app.post('/toolchain/hub/start', async (c) => {
    if (!(await isOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, []);
    if (!body) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    await deps.service.startHub().catch(() => undefined);
    return c.json({ success: true, data: await deps.service.status() });
  });

  // The hub proxy. Only allowlisted hub routes, never a shell-exec route.
  app.all('/hosts/:hostId/hub/*', async (c) => {
    const method = c.req.method.toUpperCase();
    if (
      c.req.header('upgrade') !== undefined ||
      (method !== 'GET' && method !== 'HEAD' && method !== 'POST')
    )
      return c.json({ success: false, code: 'method-not-allowed' }, 405);
    // The raw (still percent-encoded) path: an encoded separator or dot
    // segment must be refused, not decoded into an allowed shape.
    const url = new URL(c.req.url);
    const at = url.pathname.indexOf('/hosts/');
    const matched = at === -1 ? null : HUB_PATH.exec(url.pathname.slice(at));
    const hostId = matched?.[1] ?? '';
    const hubPath = matched?.[2] ?? '';
    const route = matchHubClientRoute(method, hubPath);
    const caller = await resolveDeviceCaller(
      deps.access,
      c.req.raw,
      route?.purpose === 'view' ? 'view' : 'drive',
    );
    if (!caller) return c.json(denied, 403);
    if (!knownHost(hostId))
      return c.json({ success: false, code: 'unknown-host' }, 404);
    if (!route)
      return c.json({ success: false, code: 'route-not-allowed' }, 404);
    let body: string | undefined;
    let bodyDevice: { platform: 'ios' | 'android'; id: string } | undefined;
    if (method === 'POST') {
      const read = await readBoundedRequestBody(c.req.raw, MAX_BODY_BYTES);
      if (read.status !== 'ok') return c.json(invalid, 400);
      body = read.body;
      if (route.device?.from === 'body' || route.purpose === 'operator') {
        // Boot/shutdown name the device in `{platform, id}`. Only those two
        // fields are forwarded: the hub boots an Android AVD by `name` when
        // one is given, so a `name` could otherwise redirect the boot.
        let parsed: unknown;
        try {
          parsed = JSON.parse(read.body);
        } catch {
          return c.json(invalid, 400);
        }
        const value = parsed as { platform?: unknown; id?: unknown } | null;
        if (
          !value ||
          typeof value !== 'object' ||
          !isValidMobileDeviceId(value.platform, value.id)
        )
          return c.json(invalid, 400);
        bodyDevice = { platform: value.platform, id: value.id as string };
        body = JSON.stringify(bodyDevice);
      }
    }
    // D12: an admin reaches only a device-scoped route that names a device
    // shared with their Project; every other route is the operator's.
    // An Android serial is authorized by the AVD running on it now.
    const device = hubRouteDevice(route, hubPath, url.searchParams, bodyDevice);
    if (
      caller.kind !== 'operator' &&
      (!device ||
        !(await mayUseNamedDevice(
          deps.access,
          caller,
          route.purpose,
          device.platform,
          device.deviceId,
          hostId,
        )))
    )
      return c.json(denied, 403);
    // Forward exactly the one `device` that was authorized (first wins).
    const search = new URLSearchParams(url.search);
    // `set` replaces every `device` value with the single authorized one.
    if (route.device?.from === 'query' && device)
      search.set('device', device.deviceId);
    const forwardedSearch = search.toString() ? `?${search.toString()}` : '';
    const isStream = STREAM_PATH.test(hubPath);
    const streamKeys =
      isStream && caller.kind !== 'operator'
        ? [`caller:${caller.principalId}`, `project:${caller.projectId}`]
        : [];
    if (
      streamKeys.length > 0 &&
      ((openStreams.get(streamKeys[0] ?? '') ?? 0) >= perCallerStreams ||
        (openStreams.get(streamKeys[1] ?? '') ?? 0) >= perProjectStreams)
    )
      return c.json({ success: false, code: 'too-many-streams' }, 429);
    // Reserve the slot NOW, before any await: checking here and counting
    // only once the hub answered let a concurrent burst all pass the check.
    for (const key of streamKeys)
      openStreams.set(key, (openStreams.get(key) ?? 0) + 1);
    let released = streamKeys.length === 0;
    const release = () => {
      if (released) return;
      released = true;
      for (const key of streamKeys) {
        const next = (openStreams.get(key) ?? 1) - 1;
        if (next > 0) openStreams.set(key, next);
        else openStreams.delete(key);
      }
    };
    // Held by the response stream once one is handed back; released on
    // every other way out of this handler.
    let handedOff = false;
    try {
      const connection =
        hostId === 'local'
          ? await deps.service.ensureHub()
          : await deps.remoteHubs?.ensureHub(hostId);
      if (!connection)
        return c.json({ success: false, code: 'hub-unavailable' }, 503);
      if (!deps.isRequestPrincipalCurrent(c.req.raw))
        return c.json(denied, 403);
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) headers[name] = value;
      }
      let upstream: Response;
      try {
        upstream = await connection.request(
          method as 'GET' | 'HEAD' | 'POST',
          `${hubPath}${forwardedSearch}`,
          {
            headers,
            signal: c.req.raw.signal,
            ...(body !== undefined ? { body } : {}),
          },
        );
      } catch (error) {
        if (error instanceof DeviceHubPathRefusedError)
          return c.json({ success: false, code: 'route-not-allowed' }, 404);
        return c.json({ success: false, code: 'hub-unavailable' }, 502);
      }
      const responseHeaders = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      responseHeaders.set(
        'Content-Type',
        safeContentType(upstream.headers.get('content-type')),
      );
      // An MJPEG body never ends: nothing between here and the viewer may
      // buffer or re-encode it, and no cache may keep a frame. Nothing the
      // hub returns may run as a document on Station's origin.
      responseHeaders.set('Cache-Control', 'no-store, no-transform');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      responseHeaders.set(
        'Content-Security-Policy',
        "default-src 'none'; sandbox",
      );
      let responseBody = method === 'HEAD' ? null : upstream.body;
      if (responseBody && !released) {
        handedOff = true;
        const reader = responseBody.getReader();
        responseBody = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                release();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          cancel(reason) {
            release();
            return reader.cancel(reason);
          },
        });
      }
      return new Response(responseBody, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } finally {
      if (!handedOff) release();
    }
  });

  return app;
}
