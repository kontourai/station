import type { Hono } from 'hono';
import { createFixtureLeafRoutes } from './fixture-leaf-routes.js';

/**
 * station#1131 AC1 fixture: a minimal stand-in for `runtime-routes.ts`'s
 * `configureRuntimeRoutes`, mounting one sub-router at a REAL, already
 * family-covered base (`/api/system`) so `requiredPairingScope` resolves it
 * through the genuine production table rather than needing a fixture-only
 * scope table. See `fixture-leaf-routes.ts` for the synthetic leaf itself.
 */
export function configureRuntimeRoutes(context: { app: Hono }): void {
  context.app.route('/api/system', createFixtureLeafRoutes());
}
