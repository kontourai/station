import { ACCOUNT_AUTHENTICATION_FAILURE_HEADER } from '@kontourai/station-contracts/application-session';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v3';
import { RuntimeAuthFailureLimiter } from '../../security/runtime-request-security.js';
import {
  ApplicationSessionRefusal,
  type ApplicationSessionService,
} from '../../services/identity/application-session-service.js';

/** These endpoints run before the cookie-specific account router; the owner validates Origin and Device proof. */
export function createApplicationSessionRoutes(
  service?: ApplicationSessionService,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  // No account/Device admission has happened for these public control routes
  // yet, so the body owner's Request replacement cannot lose verified proof.
  app.use('*', bodyLimit({ maxSize: 16 * 1024 }));
  const attempts = new RuntimeAuthFailureLimiter({
    maxFailures: 10,
    maxTrackedPeers: 1000,
  });
  const input = async (c: Context) => {
    const text = await c.req.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024)
      throw new z.ZodError([]);
    return JSON.parse(text) as unknown;
  };
  const run = async (
    c: Context,
    action: (owner: ApplicationSessionService) => Promise<unknown>,
  ) => {
    c.header('Cache-Control', 'no-store');
    if (!service)
      return c.json(
        { error: { code: 'application_sessions_unsupported' } },
        501,
      );
    try {
      return c.json({ data: await action(service) });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json(
          { error: { code: 'application_session_invalid_request' } },
          400,
        );
      const code =
        error instanceof ApplicationSessionRefusal ? error.code : 'unavailable';
      c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
      return c.json(
        { error: { code: `application_session_${code}` } },
        code === 'rate_limited'
          ? 429
          : code === 'unsupported'
            ? 501
            : code === 'unavailable'
              ? 503
              : code === 'origin_forbidden'
                ? 403
                : 401,
      );
    }
  };
  app.get('/', (c) => run(c, async (owner) => owner.capabilities()));
  app.post('/challenge', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({ publicKey: z.unknown() })
        .strict()
        .parse(await input(c));
      return owner.challenge(c.req.raw, body.publicKey);
    }),
  );
  app.post('/exchange', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({ challengeId: z.string(), proof: z.string().max(4096) })
        .strict()
        .parse(await input(c));
      return owner.establish(c.req.raw, body);
    }),
  );
  app.post('/login', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({
          challengeId: z.string(),
          proof: z.string().max(4096),
          credentials: z.record(z.unknown()),
        })
        .strict()
        .parse(await input(c));
      // Aggregate failures across origins/transports for this exact enrolled credential.
      const key = c.req.header('Authorization') ?? '<absent>';
      const retryAfter = attempts.retryAfterSeconds(key);
      if (retryAfter !== undefined) {
        c.header('Retry-After', String(retryAfter));
        throw new ApplicationSessionRefusal('rate_limited');
      }
      attempts.recordFailure(key);
      const headers = new Headers(c.req.raw.headers);
      headers.delete('Content-Length');
      headers.set('Content-Type', 'application/json');
      const login = new Request(c.req.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body.credentials),
        signal: c.req.raw.signal,
      });
      const result = await owner.establish(c.req.raw, body, login);
      return result;
    }),
  );
  app.post('/renew', (c) => run(c, (owner) => owner.renew(c.req.raw)));
  app.post('/revoke', (c) =>
    run(c, async (owner) => {
      await owner.revoke(c.req.raw);
      return { revoked: true };
    }),
  );
  return app;
}
