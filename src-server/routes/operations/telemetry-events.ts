import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { Hono } from 'hono';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  telemetryEventsSchema,
  validate,
} from '../schemas/schemas.js';

export function createTelemetryRoutes(logger: Logger) {
  const app = new Hono();

  app.post('/events', validate(telemetryEventsSchema), async (c) => {
    try {
      const { events } = getBody(c);
      const plugin = c.req.header(STATION_PLUGIN_HEADER) || '';
      // Log events for now — the OTLP pipeline picks them up via server metrics
      if (Array.isArray(events)) {
        for (const event of events) {
          logger.info('Plugin telemetry event', { plugin, ...event });
        }
      }
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  return app;
}
