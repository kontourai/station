import type { Hono } from 'hono';
import { createFixtureLeafRoutes } from './fixture-leaf-routes.js';

export function configureRuntimeRoutes(context: { app: Hono }): void {
  /**
   * A prose example must not count as a mount:
   * `context.app.route('/', ...)`.
   */
  void /[/*]/.test('/');
  context.app.get(
    // Comments between the method call and path literal are valid TypeScript.
    '/api/system/commented-direct-leaf',
    (c) => c.json({ ok: true }),
  );
  context.app.route(
    '/api/system',
    /* Both block and line comments are legal between mount arguments. */
    // The scanner must still discover every leaf beneath this mount.
    createFixtureLeafRoutes(),
  );
}
