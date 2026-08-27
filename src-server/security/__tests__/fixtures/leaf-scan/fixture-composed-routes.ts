import { Hono } from 'hono';
import { registerFixtureComposedSiblingRoutes } from './fixture-composed-sibling-routes.js';

/**
 * station#1131 review round 1 (AC1 follow-up, HIGH item 2). Mirrors
 * `plugins.ts`'s `createPluginRoutes`: owns a local `const app = new
 * Hono()` and hands that SAME variable to a sibling `register*Routes(app,
 * deps)` call instead of mounting a nested sub-router via `app.route(...)`.
 */
export function createFixtureComposedRoutes() {
  const app = new Hono();
  registerFixtureComposedSiblingRoutes(app, {});
  return app;
}
