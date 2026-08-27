import { Hono } from 'hono';
import type { UsageTelemetryService } from '../../services/usage-telemetry-service.js';

/** The inventory is served from the emitter's source so disclosure copy cannot drift. */
/**
 * Accepts a getter because routes are registered inside `initializeRuntime`
 * (runtime-initialize.ts) BEFORE `StationRuntime` constructs its
 * `UsageTelemetryService` (station-runtime.ts, after initialize returns). A
 * service captured by value at mount time is therefore always undefined; the
 * handler must resolve it per request and answer 503 until it exists.
 */
export function createUsageTelemetryDisclosureRoutes(
  serviceOrGetter:
    | UsageTelemetryService
    | (() => UsageTelemetryService | undefined),
) {
  const resolve = () =>
    typeof serviceOrGetter === 'function' ? serviceOrGetter() : serviceOrGetter;
  const app = new Hono();
  app.get('/disclosure', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    return c.json({ success: true, data: await service.disclosure() });
  });
  app.post('/disclosure/acknowledgements', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    await service.acknowledgeDisclosure();
    return c.json({ success: true, data: await service.disclosure() });
  });
  return app;
}
