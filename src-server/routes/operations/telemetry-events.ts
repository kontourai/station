import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
  app.post(
    '/events',
    bodyLimit({ maxSize: 64 * 1024 }),
    validate(telemetryEventsSchema),
    async (c) => {
      const service = resolve();
      if (!service)
        return c.json({ success: false, error: 'Telemetry unavailable' }, 503);
      const plugin = c.req.header(STATION_PLUGIN_HEADER);
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
