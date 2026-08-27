import type { Hono } from 'hono';
import { createFixtureComposedRoutes } from './fixture-composed-routes.js';

/**
 * station#1131 review round 1 (AC1 follow-up, HIGH item 2): a minimal
 * stand-in for `runtime-routes.ts`'s `configureRuntimeRoutes`, mounting
 * `createFixtureComposedRoutes` (the `register*Routes(app, deps)`
 * composition-helper shape) at a REAL, already family-covered base
 * (`/api/system`), so `requiredPairingScope` resolves it through the
 * genuine production table. See `fixture-composed-sibling-routes.ts` for
 * the synthetic undeclared leaf itself.
 */
export function configureRuntimeRoutes(context: { app: Hono }): void {
  context.app.route('/api/system', createFixtureComposedRoutes());
}
