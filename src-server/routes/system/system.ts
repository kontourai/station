import { Hono } from 'hono';
import { createResourcePostureRoutes } from './resource-posture-routes.js';
import type { SystemStatusDeps } from './system-route-types.js';
import { createSystemStatusRoutes } from './system-status-routes.js';
import { createSystemUpdateRoutes } from './system-update-routes.js';

export function createSystemRoutes(deps: SystemStatusDeps, logger: any) {
  const app = new Hono();
  app.route('/', createSystemStatusRoutes(deps));
  app.route('/', createSystemUpdateRoutes(deps, logger));
  app.route('/', createResourcePostureRoutes(deps));

  return app;
}
