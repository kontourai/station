import type { IntegrationStatus } from '@kontourai/station-contracts/integration-status';
import { Hono } from 'hono';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';

export function createIntegrationStatusRoutes(deps: {
  readStatus: () => Promise<IntegrationStatus>;
  mayRead: (request: Request) => boolean;
}) {
  const app = new Hono();
  app.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const current = () => !c.req.raw.signal.aborted && deps.mayRead(c.req.raw);
    const denied = () => c.json({ success: false, code: 'access-denied' }, 403);
    if (!current()) return denied();
    const data = await deps.readStatus();
    if (!current()) return denied();
    return guardProjectResponse(c.json({ success: true, data }), async () =>
      current(),
    );
  });
  return app;
}
