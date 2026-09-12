import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  attestedProxyPeerAddress,
  getDirectSocketAddress,
  RuntimeAuthFailureLimiter,
} from '../../security/runtime-request-security.js';
import type { LoadedDeploymentAuthentication } from '../../services/identity/deployment-authentication-loader.js';

/** Narrow account endpoint owner. Loading this surface grants no personal-device API scope. */
export function createDeploymentAuthenticationRoutes(
  authentication?: LoadedDeploymentAuthentication,
) {
  const app = new Hono();
  const attempts = new RuntimeAuthFailureLimiter({ maxFailures: 120 });
  app.use('*', bodyLimit({ maxSize: 32 * 1024 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!authentication)
      return c.json({ error: { code: 'authentication_not_configured' } }, 501);
    const origin = c.req.header('Origin');
    if (origin && origin !== authentication.publicOrigin)
      return c.json({ error: { code: 'origin_forbidden' } }, 403);
    if (c.req.method === 'POST' && origin !== authentication.publicOrigin)
      return c.json({ error: { code: 'origin_required' } }, 403);
    const peer =
      attestedProxyPeerAddress({
        environment: c.env,
        header: (name) => c.req.header(name),
      }) ??
      getDirectSocketAddress(c.env) ??
      '<absent>';
    const retryAfter = attempts.retryAfterSeconds(peer);
    if (retryAfter !== undefined) {
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: { code: 'authentication_rate_limited' } }, 429);
    }
    // Reserve before the asynchronous adapter so concurrent attempts are bounded.
    attempts.recordFailure(peer);
    await next();
  });
  app.get('/', (c) => c.json({ data: authentication!.service.describe() }));
  app.get('/session', async (c) => {
    const result = await authentication!.service.authenticate(c.req.raw);
    if (result.kind !== 'authenticated')
      return c.json(
        {
          error: {
            code:
              result.kind === 'unavailable'
                ? 'authentication_unavailable'
                : 'authentication_required',
          },
        },
        result.kind === 'unavailable' ? 503 : 401,
      );
    return c.json({
      data: {
        principal: result.principal,
        issuer: result.issuer,
        expiresAt: result.session.expiresAt,
        contacts: result.session.contacts,
      },
    });
  });
  const forward = (c: Context) => {
    // The mounted route path is stripped only at its fixed, Station-owned base.
    const path = new URL(c.req.url).pathname.slice(
      DEPLOYMENT_AUTHENTICATION_BASE_PATH.length,
    );
    return authentication!.service.handle(c.req.raw, path);
  };
  app.get('/*', forward);
  app.post('/*', forward);
  return app;
}
