import { Hono } from 'hono';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../security/runtime-request-security.js';

/**
 * Mounts `routes` behind the operator's authenticated principal, for a route
 * test that has no auth boundary of its own. Routes that take the authority
 * to choose a folder or a command refuse a request no auth boundary saw, so a
 * bare mount would be refused. A principal an outer layer already bound is kept.
 */
export function bindOperatorPrincipal(app: Hono<any>): void {
  app.use('*', async (c, next) => {
    if (!getRuntimeAuthenticatedRequestPrincipal(c.req.raw))
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'operator-credential',
        authority: 'operator-credential',
        source: 'bearer',
      });
    await next();
  });
}

export function withOperatorPrincipal(routes: Hono<any>): Hono<any> {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    if (!getRuntimeAuthenticatedRequestPrincipal(c.req.raw))
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
