/**
 * archive#3089: the one read path for the runtime resource posture that
 * `src-server/services/infra/resource-posture.ts` already derives and
 * enforces (`admitEngineStart` refuses at critical, `admitScheduledJob`
 * defers at degraded/critical). Nothing computes a second notion of host
 * pressure here — this route calls the SAME probe/derivation the admission
 * checks use (`RuntimeResourcePostureProbe.observe()` ->
 * `deriveRuntimeResourcePosture`), so a client reading this endpoint sees
 * exactly the classification an admission check would produce if it ran at
 * that moment. It is a fresh read each call (not a cached snapshot of a
 * specific past decision) because posture is time-varying and there is no
 * single long-lived "current decision" to echo back — see the module
 * docblock on `resource-posture.ts` for why a caller-supplied posture is
 * never trusted.
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
