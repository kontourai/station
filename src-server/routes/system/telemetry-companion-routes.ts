import type { TelemetryCompanionPrerequisites } from '@kontourai/station-contracts/telemetry-delivery';
import { Hono } from 'hono';

export function createTelemetryCompanionRoutes(deps: {
  requireOperator(request: Request): Promise<void>;
  prerequisites(
    includeArtifactEvidence: boolean,
  ): Promise<TelemetryCompanionPrerequisites>;
}) {
  const app = new Hono();
  app.get('/prerequisites', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    let data: TelemetryCompanionPrerequisites;
    try {
      data = await deps.prerequisites(c.req.query('artifactEvidence') === '1');
    } catch {
      return c.json({ error: { code: 'companion_probe_unavailable' } }, 503);
    }
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    return c.json({ data });
  });
  return app;
}
