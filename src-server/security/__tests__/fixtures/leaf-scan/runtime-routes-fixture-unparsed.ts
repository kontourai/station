import type { Hono } from 'hono';
import { createFixtureLeafRoutes } from './fixture-leaf-routes.js';

export function configureRuntimeRoutes(context: { app: Hono }): void {
  // Indexed expressions are intentionally outside the scanner's supported
  // mount-expression grammar. They must be reported, never silently skipped.
  context.app.route('/api/system', [createFixtureLeafRoutes][0]!());
}
