import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import type {
  ProjectInvitationPreview,
  ProjectMembershipScope,
} from '@kontourai/station-contracts/project-membership';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v3';
import {
  attestedProxyPeerAddress,
  getDirectSocketAddress,
  RuntimeAuthFailureLimiter,
} from '../../security/runtime-request-security.js';
import type { LoadedDeploymentAuthentication } from '../../services/identity/deployment-authentication-loader.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';

/** Narrow account endpoint owner. Loading this surface grants no personal-device API scope. */
export function createDeploymentAuthenticationRoutes(
  authentication?: LoadedDeploymentAuthentication,
  acceptInvitation?: (
    request: Request,
    token: string,
    environment: unknown,
  ) => Promise<ProjectMembershipScope>,
  previewInvitation?: (token: string) => Promise<ProjectInvitationPreview>,
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
  const invitationOperation = async (
    c: Context,
    operation?: (
      token: string,
    ) => Promise<
      | ProjectInvitationPreview
      | { scope: ProjectMembershipScope; grantsDeviceAccess: false }
    >,
  ) => {
    if (!operation)
      return c.json({ error: { code: 'project_sharing_unavailable' } }, 501);
    try {
      const body = z
        .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(await c.req.json());
      return c.json({ data: await operation(body.token) });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ error: { code: 'invalid_invitation_request' } }, 400);
      if (error instanceof ProjectMembershipRefusal)
        return c.json(
          { error: { code: `project_access_${error.code}` } },
          error.code === 'unavailable'
            ? 503
            : error.code === 'forbidden'
              ? 403
              : 409,
        );
      return c.json({ error: { code: 'project_access_unavailable' } }, 503);
    }
  };
  app.post('/invitation-preview', (c) =>
    invitationOperation(c, previewInvitation),
  );
  app.post('/accept-invitation', (c) =>
    invitationOperation(
      c,
      acceptInvitation
        ? async (token) => ({
            scope: await acceptInvitation(c.req.raw, token, c.env),
            grantsDeviceAccess: false,
          })
        : undefined,
    ),
  );
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
