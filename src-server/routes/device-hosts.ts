/**
 * SSH device hosts: the operator's CRUD, connection test and hub consent
 * (#1973, D11). Mounted under `/api/mobile-devices` ONLY on personal Station
 * hosts, beside the device toolchain routes.
 *
 * Every route is the Station OPERATOR's alone (D12: devices and the machines
 * they run on are the operator's): a host is a machine Station will ssh into
 * with the operator's own keys, install software onto, and run a process
 * on. A non-operator is refused before the body is read and learns nothing
 * about which hosts exist. Pairing scopes (`pairing-route-scopes.ts`): the
 * list at `orchestration:read`, everything else at `terminal:operate`.
 *
 * Validation is here, at the route seam: strict JSON bodies with known keys
 * only, the host id grammar, and the store's own label and ssh-target
 * grammar (`ssh-device-target.ts`), which refuses anything option-shaped.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  DeviceHostError,
  type DeviceHostRegistry,
} from '../services/devices/hosts/device-host-registry.js';
import {
  DeviceHostStoreError,
  isSshDeviceHostId,
} from '../services/devices/hosts/device-host-store.js';

const MAX_BODY_BYTES = 4 * 1024;

export interface DeviceHostRoutesDeps {
  registry: Pick<
    DeviceHostRegistry,
    | 'views'
    | 'view'
    | 'add'
    | 'update'
    | 'remove'
    | 'check'
    | 'setHubEnabled'
    | 'startHub'
  >;
  /** The request carries Station operator authority (fails closed). */
  isOperator(request: Request): Promise<boolean>;
  isRequestPrincipalCurrent(request: Request): boolean;
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

export function createDeviceHostRoutes(deps: DeviceHostRoutesDeps) {
  const app = new Hono();
  const denied = { success: false, code: 'access-denied' } as const;
  const invalid = { success: false, code: 'invalid-request' } as const;
  const notFound = { success: false, code: 'not-found' } as const;

  const operator = async (request: Request) => {
    try {
      return (await deps.isOperator(request)) === true;
    } catch {
      return false;
    }
  };

  // Scoped to THIS family's paths. These routes share the
  // `/api/mobile-devices` mount with the device, toolchain and tools
  // routes; a `*` here would run for all of them and refuse every
  // non-operator there too (a Project admin's shared device, a drawer read).
  const operatorOnly: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    // Operator first: a non-operator learns nothing, not even a 404.
    if (!(await operator(c.req.raw))) return c.json(denied, 403);
    await next();
  };
  app.use('/device-hosts', operatorOnly);
  app.use('/device-hosts/*', operatorOnly);

  const storeRefusal = (error: unknown) => {
    if (error instanceof DeviceHostStoreError)
      return {
        body: { success: false, code: error.code } as const,
        status:
          error.code === 'not-found'
            ? (404 as const)
            : error.code === 'duplicate'
              ? (409 as const)
              : (400 as const),
      };
    if (error instanceof DeviceHostError)
      return {
        body: { success: false, code: error.code } as const,
        status: error.code === 'not-found' ? (404 as const) : (400 as const),
      };
    return undefined;
  };

  app.get('/device-hosts', (c) =>
    c.json({ success: true, data: { hosts: deps.registry.views() } }),
  );

  app.post('/device-hosts', async (c) => {
    const body = await readJsonObject(c.req.raw, ['label', 'sshTarget']);
    if (!body) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      return c.json(
        {
          success: true,
          data: deps.registry.add({
            label: body.label,
            sshTarget: body.sshTarget,
          }),
        },
        201,
      );
    } catch (error) {
      const refusal = storeRefusal(error);
      if (refusal) return c.json(refusal.body, refusal.status);
      throw error;
    }
  });

  app.patch('/device-hosts/:hostId', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isSshDeviceHostId(hostId)) return c.json(invalid, 400);
    const body = await readJsonObject(c.req.raw, ['label', 'sshTarget']);
    if (!body || Object.keys(body).length === 0) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      return c.json({
        success: true,
        data: await deps.registry.update(hostId, {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sshTarget !== undefined
            ? { sshTarget: body.sshTarget }
            : {}),
        }),
      });
    } catch (error) {
      const refusal = storeRefusal(error);
      if (refusal) return c.json(refusal.body, refusal.status);
      throw error;
    }
  });

  app.delete('/device-hosts/:hostId', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isSshDeviceHostId(hostId)) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      await deps.registry.remove(hostId);
    } catch (error) {
      const refusal = storeRefusal(error);
      if (refusal) return c.json(refusal.body, refusal.status);
      throw error;
    }
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data: { removed: true } });
  });

  // "Test connection": runs ssh (with the operator's keys) and a read-only
  // probe on the host. Starts and installs nothing.
  app.post('/device-hosts/:hostId/check', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isSshDeviceHostId(hostId)) return c.json(invalid, 400);
    if (!(await readJsonObject(c.req.raw, []))) return c.json(invalid, 400);
    if (!deps.registry.view(hostId)) return c.json(notFound, 404);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const data = await deps.registry.check(hostId);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data });
  });

  // Enable (consent: the literal `true`, installs the verified hub there)
  // or disable the hub on a host.
  app.post('/device-hosts/:hostId/hub', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isSshDeviceHostId(hostId)) return c.json(invalid, 400);
    const body = await readJsonObject(c.req.raw, ['enabled', 'consent']);
    if (!body || typeof body.enabled !== 'boolean') return c.json(invalid, 400);
    if (body.enabled && body.consent !== true)
      return c.json({ success: false, code: 'consent-required' }, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      const data = await deps.registry.setHubEnabled(hostId, {
        enabled: body.enabled,
        consent: body.consent,
      });
      return c.json({ success: true, data }, body.enabled ? 202 : 200);
    } catch (error) {
      const refusal = storeRefusal(error);
      if (refusal) return c.json(refusal.body, refusal.status);
      throw error;
    }
  });

  // Start the host's hub, or start it again after it failed.
  app.post('/device-hosts/:hostId/hub/start', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isSshDeviceHostId(hostId)) return c.json(invalid, 400);
    if (!(await readJsonObject(c.req.raw, []))) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      return c.json({
        success: true,
        data: await deps.registry.startHub(hostId),
      });
    } catch (error) {
      const refusal = storeRefusal(error);
      if (refusal) return c.json(refusal.body, refusal.status);
      throw error;
    }
  });

  return app;
}
