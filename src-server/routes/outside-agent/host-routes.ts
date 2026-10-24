// UNWIRED(#4115): R2a routes are composed only by isolated tests until R6.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { ZodError, z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { isBoundLocalGrantMintedOperator } from '../../security/runtime-request-security.js';
import type {
  OutsideAgentManagementService,
  OutsideDecisionActor,
} from '../../services/outside-agent/management-service.js';
import { OutsideOAuthRefusal } from '../../services/outside-agent/oauth-records.js';

export interface OutsideAgentHostRouteDependencies {
  service: OutsideAgentManagementService;
  /** Captured from the existing local-grant mint owner for this instance/boot, never re-read from disk. */
  localGrantSecret: string;
  actor: OutsideDecisionActor & { kind: 'host' };
}
const decision = z
  .object({
    action: z.unknown(),
    fingerprint: z.string().max(32768),
    decisionId: z.string(),
  })
  .strict();
const review = z.object({ action: z.unknown() }).strict();

export function registerOutsideAgentHostRoutes(
  app: Hono,
  deps: OutsideAgentHostRouteDependencies,
): void {
  const attempts = new WeakSet<Request>();
  const bodies = new WeakMap<Request, unknown>();
  // Per-host-process budget: only current host-proof holders reach it; they share host authority.
  let windowStart = deps.service.now();
  let count = 0;
  app.use('/api/outside-agent/*', async (c, next) => {
    const proof = c.req.header('x-station-host-proof');
    const equal = (value: string) =>
      createHash('sha256').update(value).digest();
    if (
      !isBoundLocalGrantMintedOperator(c.req.raw) ||
      !proof ||
      !deps.localGrantSecret ||
      !timingSafeEqual(equal(proof), equal(deps.localGrantSecret)) ||
      c.req.header('origin') !== undefined ||
      c.req.header('sec-fetch-site') !== undefined
    )
      return c.json({ error: 'host_proof_required' }, 403);
    // The shared service rechecks live actor/Project authority under its mutation lock.
    if (deps.service.now() - windowStart >= 60_000) {
      windowStart = deps.service.now();
      count = 0;
    }
    if (++count > 120) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate_limited' }, 429);
    }
    attempts.add(c.req.raw);
    await next();
  });
  const guarded =
    (handler: (c: Context) => unknown | Promise<unknown>) =>
    async (c: Context) => {
      if (!attempts.has(c.req.raw))
        return c.json({ error: 'host_proof_required' }, 403);
      try {
        if (c.req.method === 'POST') {
          if (
            c.req.header('content-type')?.split(';')[0] !== 'application/json'
          )
            return c.json({ error: 'invalid_request' }, 400);
          const bounded = await readBoundedRequestBody(c.req.raw, 48 * 1024);
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
          const parsed: unknown = JSON.parse(bounded.body);
          // JSON.parse accepts duplicate keys; reviews must have one unambiguous value per field.
          const tokens =
            bounded.body.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
          const stack: (Set<string> | null)[] = [];
          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token === '{') stack.push(new Set());
            else if (token === '[') stack.push(null);
            else if (token === '}' || token === ']') stack.pop();
            else if (token.startsWith('"') && tokens[i + 1] === ':') {
              const keys = stack.at(-1);
              const key: string = JSON.parse(token);
              if (!keys || keys.has(key))
                return c.json({ error: 'invalid_request' }, 400);
              keys.add(key);
            }
          }
          bodies.set(c.req.raw, parsed);
        }
        return c.json(await handler(c));
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError)
          return c.json({ error: 'invalid_request' }, 400);
        if (error instanceof OutsideOAuthRefusal)
          return c.json(
            { error: error.code },
            error.code === 'capacity' || error.code === 'audit_capacity'
              ? 429
              : 409,
          );
        throw error;
      }
    };
  const commit = (operation: string) =>
    guarded(async (c) => {
      const body = decision.parse(bodies.get(c.req.raw));
      const action = body.action;
      if (
        !action ||
        typeof action !== 'object' ||
        !('operation' in action) ||
        action.operation !== operation
      )
        throw new OutsideOAuthRefusal('invalid_request');
      return deps.service.commit(body, deps.actor);
    });
  app.get(
    '/api/outside-agent/clients',
    guarded(() => deps.service.list(deps.actor)),
  );
  app.get(
    '/api/outside-agent/redirect-origins',
    guarded(() => deps.service.origins(deps.actor, 'redirect')),
  );
  app.get(
    '/api/outside-agent/cors-origins',
    guarded(() => deps.service.origins(deps.actor, 'cors')),
  );
  app.post(
    '/api/outside-agent/host/review',
    guarded(async (c) =>
      deps.service.review(
        review.parse(bodies.get(c.req.raw)).action,
        deps.actor,
      ),
    ),
  );
  app.post('/api/outside-agent/host/confirm', commit('approve'));
  app.post('/api/outside-agent/host/deny', commit('deny'));
  app.post('/api/outside-agent/host/register', commit('register'));
  app.post(
    '/api/outside-agent/grants/:id/change',
    guarded(async (c) => {
      const body = decision.parse(bodies.get(c.req.raw));
      if (
        !body.action ||
        typeof body.action !== 'object' ||
        !('grantId' in body.action) ||
        !('operation' in body.action) ||
        body.action.operation !== 'change' ||
        body.action.grantId !== c.req.param('id')
      )
        throw new OutsideOAuthRefusal('invalid_request');
      return deps.service.commit(body, deps.actor);
    }),
  );
  app.post(
    '/api/outside-agent/grants/:id/revoke',
    guarded(async (c) => {
      const body = decision.parse(bodies.get(c.req.raw));
      if (
        !body.action ||
        typeof body.action !== 'object' ||
        !('grantId' in body.action) ||
        !('operation' in body.action) ||
        body.action.operation !== 'revoke' ||
        body.action.grantId !== c.req.param('id')
      )
        throw new OutsideOAuthRefusal('invalid_request');
      return deps.service.commit(body, deps.actor);
    }),
  );
  app.post(
    '/api/outside-agent/redirect-origins/change',
    guarded(async (c) => {
      const body = decision.parse(bodies.get(c.req.raw));
      if (
        !body.action ||
        typeof body.action !== 'object' ||
        !('policy' in body.action) ||
        body.action.policy !== 'redirect'
      )
        throw new OutsideOAuthRefusal('invalid_request');
      return deps.service.commit(body, deps.actor);
    }),
  );
  app.post(
    '/api/outside-agent/cors-origins/change',
    guarded(async (c) => {
      const body = decision.parse(bodies.get(c.req.raw));
      if (
        !body.action ||
        typeof body.action !== 'object' ||
        !('policy' in body.action) ||
        body.action.policy !== 'cors'
      )
        throw new OutsideOAuthRefusal('invalid_request');
      return deps.service.commit(body, deps.actor);
    }),
  );
}
