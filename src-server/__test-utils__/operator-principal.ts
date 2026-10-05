import { Hono } from 'hono';
import { setRuntimeAuthenticatedRequestPrincipal } from '../security/runtime-request-security.js';

/**
 * Mounts `routes` behind the operator's authenticated principal, for a route
 * test that has no auth boundary of its own. Routes that take the authority
 * to choose a folder or a command refuse a request no auth boundary saw, so a
 * bare mount would be refused.
 */
export function withOperatorPrincipal(routes: Hono<any>): Hono<any> {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      credential: 'operator-credential',
      authority: 'operator-credential',
      source: 'bearer',
    });
    await next();
  });
  app.route('/', routes);
  return app;
}
