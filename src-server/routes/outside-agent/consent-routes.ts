// UNWIRED(#4115): isolated composition only until R6; register before the host-only router.
import { type Context, Hono } from 'hono';
import { ZodError, z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { ConsentCommitRefusedError } from '../../services/consent/consent-transactions.js';
import type { OutsideAgentConsentService } from '../../services/outside-agent/consent-service.js';
import { OutsideOAuthRefusal } from '../../services/outside-agent/oauth-records.js';
import { parseOutsideManagementJson } from './request-body.js';

const bodySchema = z.object({ action: z.unknown() }).strict();

export function registerOutsideAgentConsentRoutes(
  app: Hono,
  deps: {
    service: OutsideAgentConsentService;
    appOrigin: string;
  },
): void {
  const sessionFor = (c: Context) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    return principal?.authority === 'operator-session' &&
      principal.source === 'session' &&
      principal.operatorSession?.isCurrent()
      ? principal.operatorSession
      : null;
  };
  const mutation =
    (operation: string, policy?: 'redirect' | 'cors') =>
    async (c: Context, next: () => Promise<void>) => {
      const session = sessionFor(c);
      if (!session) {
        // The shared grant/origin leaves may continue into the independently guarded host path.
        if (
          operation === 'change' ||
          operation === 'revoke' ||
          operation === 'origin'
        )
          return next();
        return c.json({ error: 'operator_session_required' }, 403);
      }
      if (
        c.req.header('origin') !== deps.appOrigin ||
        c.req.header('sec-fetch-site') !== 'same-origin'
      )
        return c.json({ error: 'origin_mismatch' }, 403);
      if (
        c.req.header('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        return c.json({ error: 'invalid_request' }, 400);
      const bounded = await readBoundedRequestBody(c.req.raw, 32 * 1024);
      if (bounded.status !== 'ok')
        return c.json(
          {
            error:
              bounded.status === 'too-large'
                ? 'payload_too_large'
                : 'invalid_request',
          },
          bounded.status === 'too-large' ? 413 : 400,
        );
      try {
        const action = bodySchema.parse(
          parseOutsideManagementJson(bounded.body),
        ).action;
        if (
          !action ||
          typeof action !== 'object' ||
          !('operation' in action) ||
          action.operation !== operation
        )
          return c.json({ error: 'invalid_request' }, 400);
        if (
          (operation === 'approve' || operation === 'deny') &&
          (!('requestId' in action) || action.requestId !== c.req.param('id'))
        )
          return c.json({ error: 'invalid_request' }, 400);
        if (
          (operation === 'change' || operation === 'revoke') &&
          (!('grantId' in action) || action.grantId !== c.req.param('id'))
        )
          return c.json({ error: 'invalid_request' }, 400);
        if (policy && (!('policy' in action) || action.policy !== policy))
          return c.json({ error: 'invalid_request' }, 400);
        const created = deps.service.request(action, session);
        if (!created.ok) return c.json({ error: created.reason }, 429);
        return c.json(
          {
            status: 'step_up_required',
            transaction: {
              id: created.transaction.id,
              reviewUrl: deps.service.channel.reviewUrlFor(
                c.req.header('host'),
                created.transaction.id,
              ),
              expiresAt: created.transaction.expiresAt,
            },
          },
          202,
        );
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError)
          return c.json({ error: 'invalid_request' }, 400);
        if (error instanceof ConsentCommitRefusedError)
          return c.json({ error: error.reason }, 409);
        if (error instanceof OutsideOAuthRefusal)
          return c.json({ error: error.code }, 409);
        throw error;
      }
    };
  app.post('/api/outside-agent/requests/:id/approval', mutation('approve'));
  app.post('/api/outside-agent/requests/:id/denial', mutation('deny'));
  app.post('/api/outside-agent/grants/:id/change', mutation('change'));
  app.post('/api/outside-agent/grants/:id/revoke', mutation('revoke'));
  app.post(
    '/api/outside-agent/redirect-origins/change',
    mutation('origin', 'redirect'),
  );
  app.post(
    '/api/outside-agent/cors-origins/change',
    mutation('origin', 'cors'),
  );

  app.get('/api/outside-agent/transactions/:id', (c) => {
    const session = sessionFor(c);
    if (!session) return c.json({ error: 'operator_session_required' }, 403);
    const channel = deps.service.channel;
    const transaction = channel.store.get(channel.tenantId, c.req.param('id'));
    if (
      !transaction ||
      transaction.operatorSessionId !== session.sessionId ||
      !transaction.target.kind.startsWith('outside-agent-')
    )
      return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({
      status: transaction.status,
      ...(transaction.effect ? { effect: transaction.effect } : {}),
    });
  });
  app.get('/api/outside-agent/clients', (c, next) => {
    const session = sessionFor(c);
    if (!session) return next();
    c.header('Cache-Control', 'no-store');
    return c.json(
      deps.service.management.list(
        deps.service.actorFor(session, session.passkeyId),
      ),
    );
  });
  app.get('/api/outside-agent/requests/:id', (c) => {
    const session = sessionFor(c);
    if (!session) return c.json({ error: 'operator_session_required' }, 403);
    const row = deps.service.management
      .list(deps.service.actorFor(session, session.passkeyId))
      .pending.find((r) => r.requestId === c.req.param('id'));
    c.header('Cache-Control', 'no-store');
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
  });
  const origins =
    (policy: 'redirect' | 'cors') =>
    (c: Context, next: () => Promise<void>) => {
      const session = sessionFor(c);
      if (!session) return next();
      c.header('Cache-Control', 'no-store');
      return c.json(
        deps.service.management.origins(
          deps.service.actorFor(session, session.passkeyId),
          policy,
        ),
      );
    };
  app.get('/api/outside-agent/redirect-origins', origins('redirect'));
  app.get('/api/outside-agent/cors-origins', origins('cors'));
}
