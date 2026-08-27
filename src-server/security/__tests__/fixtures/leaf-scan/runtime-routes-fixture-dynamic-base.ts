import { createFixtureLeafRoutes } from './fixture-leaf-routes.js';

export function configureRuntimeRoutes(context: { app: any }): void {
  const base = '/api/system';
  context.app.route(base, createFixtureLeafRoutes());
}
