import {
  ACCOUNT_AUTHENTICATION_FAILURE_HEADER,
  APPLICATION_SESSION_NATIVE_BASE_PATH,
  APPLICATION_SESSION_NATIVE_VERSION,
} from '@kontourai/station-contracts/application-session';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v3';
import {
  getRuntimeNativeDeviceProofPrincipal,
  isRuntimeNativeDeviceProofCurrent,
  RuntimeAuthFailureLimiter,
} from '../../security/runtime-request-security.js';
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
  const ordinaryBodyLimit = bodyLimit({ maxSize: 16 * 1024 });
  app.use('*', (c, next) =>
    new URL(c.req.url).pathname.startsWith(
      `${APPLICATION_SESSION_NATIVE_BASE_PATH}/`,
    )
      ? next()
      : ordinaryBodyLimit(c, next),
  );
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
  // Hono's bodyLimit replaces Request identity after buffering. Native Pion
  // provenance is intentionally attached to that exact Request, so bound the
  // native body without replacing it or copying its authority to a clone.
  const nativeInput = async (c: Context) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new z.ZodError([]);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024) {
          await reader.cancel();
          throw new z.ZodError([]);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof TypeError) throw new SyntaxError('Invalid UTF-8');
      throw error;
    }
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
  app.post('/adopt-cookie/challenge', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({ publicKey: z.unknown() })
        .strict()
        .parse(await input(c));
      return owner.cookieAdoptionChallenge(c.req.raw, body.publicKey);
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
  app.post('/adopt-cookie/complete', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({ challengeId: z.string(), proof: z.string().max(4096) })
        .strict()
        .parse(await input(c));
      return owner.completeCookieAdoption(c.req.raw, body);
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
  app.post('/native/challenge', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({
          version: z.literal(APPLICATION_SESSION_NATIVE_VERSION),
          publicKey: z.unknown(),
        })
        .strict()
        .parse(await nativeInput(c));
      return owner.nativeChallenge(c.req.raw, { publicKey: body.publicKey });
    }),
  );
  app.post('/native/exchange', (c) =>
    run(c, async (owner) => {
      const body = z
        .object({
          version: z.literal(APPLICATION_SESSION_NATIVE_VERSION),
          challengeId: z.string(),
          credentials: z.record(z.unknown()),
          proof: z.string().max(4096),
        })
        .strict()
        .parse(await nativeInput(c));
      // #2893: a native exchange attempt is bounded by the VERIFIED Device
      // identity minted at the admission seam, never by the
      // Authorization '<absent>' bucket every proof attempt would share.
      const native = getRuntimeNativeDeviceProofPrincipal(c.req.raw);
      const key =
        native && isRuntimeNativeDeviceProofCurrent(c.req.raw)
          ? `native-device:${native.deviceId}`
          : (c.req.header('Authorization') ?? '<absent>');
      const retryAfter = attempts.retryAfterSeconds(key);
      if (retryAfter !== undefined) {
        c.header('Retry-After', String(retryAfter));
        throw new ApplicationSessionRefusal('rate_limited');
      }
      attempts.recordFailure(key);
      return owner.establishNative(c.req.raw, body);
    }),
  );
  app.post('/native/revoke', (c) =>
    run(c, async (owner) => {
      z.object({})
        .strict()
        .parse(await nativeInput(c));
      return owner.revokeNative(c.req.raw);
    }),
  );
  app.post('/renew', (c) => run(c, (owner) => owner.renew(c.req.raw)));
  app.post('/revoke', (c) =>
    run(c, async (owner) => {
      await owner.revoke(c.req.raw);
      return { revoked: true };
    }),
  );
  app.post('/adopt-cookie/revoke-alias', (c) =>
    run(c, (owner) => owner.revokeAlias(c.req.raw)),
  );
  return app;
}
