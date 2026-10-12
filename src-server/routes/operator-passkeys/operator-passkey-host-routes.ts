/**
 * Host-side operator passkey administration (#3257, S2b).
 *
 * Mounted at `/api/pairing/operator-passkeys` inside the device-pairing host
 * routes, so it sits under the `/api/pairing` `access:manage` family AND
 * answers only the operator credential: each handler repeats the same
 * `currentOperator` check the device scope and revoke routes use, because a
 * device holding `access:manage` is still not the operator.
 *
 * The browser half (request, ceremony) is on the consent origin, not here:
 * see `src-server/runtime/consent/operator-passkey-enrollment-routes.ts`.
 * This module is what `station environment operator passkeys` calls.
 *
 * Remote revoke with a step-up from another passkey is S4 (D8); this is the
 * host-confirmed path only.
 */
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  OperatorPasskeyEnrollmentError,
  type OperatorPasskeyEnrollmentService,
  publicEnrollmentMessage,
} from '../../services/identity/operator-passkey-enrollment.js';

export interface OperatorPasskeyHostRouteDeps {
  readonly service: OperatorPasskeyEnrollmentService;
  /** The caller is the operator credential and its principal is still current. */
  readonly isOperator: (context: unknown) => boolean;
}

const BODY_LIMIT_BYTES = 1_024;

function statusFor(
  error: OperatorPasskeyEnrollmentError,
): 400 | 404 | 409 | 429 | 503 {
  switch (error.code) {
    case 'invalid_code':
      return 404;
    case 'device_mismatch':
    case 'device_gone':
      return 409;
    case 'passkey_not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'enrollment_unavailable':
    case 'store_unavailable':
      return 503;
    default:
      return 400;
  }
}

export function createOperatorPasskeyHostRoutes(
  deps: OperatorPasskeyHostRouteDeps,
): Hono {
  const app = new Hono();

  const guarded =
    (handler: (c: Context) => Response | Promise<Response>) =>
    async (c: Context) => {
      if (!deps.isOperator(c)) {
        return c.json({ error: 'authentication_required' }, 401);
      }
      try {
        return await handler(c);
      } catch (error) {
        if (error instanceof OperatorPasskeyEnrollmentError) {
          return c.json(
            {
              error: error.code,
              message: publicEnrollmentMessage(error),
              ...(error.retryAfterMs !== undefined
                ? { retryAfterMs: error.retryAfterMs }
                : {}),
            },
            statusFor(error),
          );
        }
        // Anything else is unexpected. Rethrow so the runtime `onError` logs
        // it with its cause and answers the standard sanitized 500; this
        // route never decides what text an unexpected failure shows.
        throw error;
      }
    };

  const limited = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });

  async function readBody(
    request: Request,
  ): Promise<{ code?: unknown; device?: unknown }> {
    try {
      const parsed: unknown = JSON.parse(await request.text());
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as { code?: unknown; device?: unknown })
        : {};
    } catch {
      return {};
    }
  }

  app.get(
    '/',
    guarded((c) =>
      c.json({
        enrollment: deps.service.availability(),
        passkeys: deps.service.listPasskeys(),
        pending: deps.service.listPending(),
      }),
    ),
  );

  app.post(
    '/requests/inspect',
    limited,
    guarded(async (c) =>
      c.json(deps.service.inspect((await readBody(c.req.raw)).code)),
    ),
  );

  app.post(
    '/requests/approve',
    limited,
    guarded(async (c) => {
      const body = await readBody(c.req.raw);
      return c.json(deps.service.confirm(body.code, body.device));
    }),
  );

  app.post(
    '/requests/deny',
    limited,
    guarded(async (c) =>
      c.json(deps.service.deny((await readBody(c.req.raw)).code)),
    ),
  );

  app.delete(
    '/:id',
    guarded((c) => c.json(deps.service.revokePasskey(c.req.param('id')))),
  );

  return app;
}
