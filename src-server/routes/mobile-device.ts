import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  type LocalMobileDeviceHost,
  MobileDeviceHostError,
} from '../services/mobile-device/mobile-device-host.js';

/** Authentication is rechecked after capture, before publishing private screen data. */
export function createMobileDeviceRoutes(
  host: Pick<LocalMobileDeviceHost, 'inventory' | 'capture'>,
  options: { isRequestPrincipalCurrent: (request: Request) => boolean },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    await next();
  });
  app.get('/hosts/local/devices', async (c) => {
    const data = await host.inventory();
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'access-denied' }, 403);
    return c.json({ success: true, data });
  });
  app.post('/hosts/:hostId/devices/:platform/:deviceId/capture', async (c) => {
    const platform = c.req.param('platform');
    if (platform !== 'ios' && platform !== 'android')
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
    try {
      const data = await host.capture({
        hostId: c.req.param('hostId'),
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
  return app;
}
