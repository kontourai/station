import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import type { UsageTelemetryService } from '../../services/usage-telemetry-service.js';
import {
  getBody,
  telemetryEventsSchema,
  validate,
} from '../schemas/schemas.js';

export function createTelemetryRoutes(
  resolve: () => UsageTelemetryService | undefined,
) {
  const app = new Hono();
  app.post('/panes', bodyLimit({ maxSize: 1024 }), async (c) => {
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json({ success: false }, 403);
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== 'object' ||
      !('plugin' in body) ||
      typeof body.plugin !== 'string' ||
      body.plugin.length > 128
    )
      return c.json({ success: false }, 400);
    try {
      const data = await resolve()?.mountPluginTelemetryPane(body.plugin);
      if (!data) return c.json({ success: false }, 503);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data });
    } catch {
      return c.json({ success: false }, 400);
    }
  });
  app.post(
    '/events',
    bodyLimit({ maxSize: 64 * 1024 }),
    validate(telemetryEventsSchema),
    async (c) => {
      if (requestMayBeAnAgent(c.req.raw))
        return c.json({ success: false }, 403);
      const service = resolve();
      if (!service)
        return c.json({ success: false, error: 'Telemetry unavailable' }, 503);
      const plugin = c.req.header('x-station-plugin-capability');
      if (!plugin)
        return c.json(
          { success: false, error: 'Plugin identity required' },
          400,
        );
      try {
        await service.countPluginTelemetry(plugin, getBody(c).events);
        return c.json({ success: true });
      } catch {
        return c.json(
          {
            success: false,
            error:
              'Telemetry rejected: plugin must be verified and event, properties and values must match its declaration.',
          },
          400,
        );
      }
    },
  );
  return app;
}
