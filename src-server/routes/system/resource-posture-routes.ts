/**
 * Read-only developer diagnostics for the product-owned CPU sampler. Nothing
 * in product admission may branch on this route or its probe.
 *
 * `deps.resourcePosture` absent (older/partial route composition) degrades
 * to a 503, never a fabricated healthy reading.
 */
import { Hono } from 'hono';
import type { RuntimeResourcePostureProbe } from '../../services/infra/resource-posture.js';
import { systemOps } from '../../telemetry/metrics.js';
import { errorMessage } from '../schemas/schemas.js';

export interface ResourcePostureRouteDeps {
  resourcePosture?: RuntimeResourcePostureProbe;
}

export function createResourcePostureRoutes(deps: ResourcePostureRouteDeps) {
  const app = new Hono();

  app.get('/resource-posture', async (c) => {
    if (!deps.resourcePosture) {
      return c.json(
        { success: false, error: 'Resource posture probe unavailable' },
        503,
      );
    }
    try {
      const posture = await deps.resourcePosture.observe();
      systemOps.add(1, { op: 'get_resource_posture' });
      return c.json({ success: true, data: posture });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
