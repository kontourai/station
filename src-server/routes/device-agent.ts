import { parseLiveSurfaceInputBatch } from '@kontourai/station-contracts/live-surface';
import { isMobileDeviceHostId } from '@kontourai/station-contracts/mobile-device';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  authorizeDeviceAgentCaller,
  type DeviceAgentAccessDeps,
} from '../services/devices/device-agent-authority.js';
import type { DeviceAutomation } from '../services/devices/device-automation.js';
import { DeviceSessionError } from '../services/devices/device-session-service.js';
import { DeviceHostBusyError } from '../services/devices/device-shares.js';
import { isValidMobileDeviceId } from '../services/mobile-device/mobile-device-host.js';
import type { StationControlCaller } from '../tools/station-control-shared.js';

export interface DeviceAgentRoutesDeps
  extends Omit<DeviceAgentAccessDeps, 'resolveCaller'> {
  isInternalRequest(request: Request): boolean;
  resolveCaller(request: Request): StationControlCaller | null;
  automation: DeviceAutomation;
}

export function createDeviceAgentRoutes(deps: DeviceAgentRoutesDeps) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404);
    await next();
  });
  app.onError((error, c) =>
    c.json({
      ok: false,
      code:
        error instanceof DeviceSessionError
          ? error.code
          : error instanceof DeviceHostBusyError
            ? 'device-host-busy'
            : 'device-error',
    }),
  );
  app.post('/:operation', async (c) => {
    const access = {
      ...deps,
      resolveCaller: () => deps.resolveCaller(c.req.raw),
    };
    const decided = await authorizeDeviceAgentCaller(access);
    if (!decided.ok) return c.json(decided);
    const read = await readBoundedRequestBody(c.req.raw, 16 * 1024);
    let body: Record<string, unknown>;
    try {
      const value: unknown =
        read.status === 'ok' ? JSON.parse(read.body || '{}') : null;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      body = value as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, code: 'invalid-request' });
    }
    const authority = decided.authority;
    const operation = c.req.param('operation');
    if (operation === 'list')
      return c.json(await deps.automation.list(access, authority));
    if (operation === 'open') {
      if (
        (body.reveal !== undefined && typeof body.reveal !== 'boolean') ||
        (body.hostId !== undefined && !isMobileDeviceHostId(body.hostId)) ||
        (body.platform !== 'ios' && body.platform !== 'android') ||
        typeof body.deviceId !== 'string' ||
        !isValidMobileDeviceId(body.platform, body.deviceId)
      )
        return c.json({ ok: false, code: 'invalid-target' });
      return c.json(
        await deps.automation.open(
          access,
          authority,
          {
            hostId: typeof body.hostId === 'string' ? body.hostId : 'local',
            platform: body.platform,
            deviceId: body.deviceId,
          },
          body.reveal !== false,
        ),
      );
    }
    const id = body.deviceSessionId;
    if (typeof id !== 'string' || !id || id.length > 80)
      return c.json({ ok: false, code: 'invalid-request' });
    if (operation === 'input') {
      const batch = parseLiveSurfaceInputBatch({
        epoch: 0,
        events: body.events,
      });
      if (!batch) return c.json({ ok: false, code: 'invalid-request' });
      return c.json(
        await deps.automation.input(access, authority, id, batch.events),
      );
    }
    if (operation === 'screenshot' || operation === 'snapshot')
      return c.json(
        await deps.automation.observe(
          access,
          authority,
          id,
          operation === 'screenshot',
        ),
      );
    if (operation === 'close')
      return c.json(await deps.automation.close(access, authority, id));
    return c.json({ ok: false, code: 'invalid-request' });
  });
  return app;
}
