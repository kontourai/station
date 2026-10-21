import { type Context, Hono } from 'hono';
import {
  type StoredTelemetryProducer,
  TELEMETRY_PRODUCER_LIMIT,
  TELEMETRY_PRODUCER_MAX_EXPIRY_DAYS,
  TelemetryProducerError,
  type TelemetryProducerStore,
} from '../services/telemetry-producers/telemetry-producer-store.js';

/** A producer as the management API shows it: never the secret or its hash. */
function project(store: TelemetryProducerStore, p: StoredTelemetryProducer) {
  return {
    name: p.name,
    createdAt: new Date(p.createdAt).toISOString(),
    expiresAt:
      p.expiresAt === null ? null : new Date(p.expiresAt).toISOString(),
    expired: store.isExpired(p),
    allowRemote: p.allowRemote,
    lastUsedAt:
      p.lastUsedAt === null ? null : new Date(p.lastUsedAt).toISOString(),
  };
}

/**
 * Fixed outward text per refusal code: the store's error messages stay
 * server-side, so nothing it might one day interpolate reaches a response.
 */
const REFUSALS = {
  invalid_request: {
    status: 400,
    error: `A producer name is 1-63 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit; expiresInDays is a whole number from 1 through ${TELEMETRY_PRODUCER_MAX_EXPIRY_DAYS}.`,
  },
  producer_exists: {
    status: 409,
    error:
      'A telemetry producer with that name already exists. Revoke it first or choose another name.',
  },
  producer_limit_reached: {
    status: 409,
    error: `At most ${TELEMETRY_PRODUCER_LIMIT} telemetry producers can exist. Revoke one first.`,
  },
  producers_unavailable: {
    status: 503,
    error:
      'The telemetry producer record is unsafe or unreadable. Restore it to an owner-only (0600) regular file, or delete security/telemetry-producers.json in the Station home and create the producers again.',
  },
} as const satisfies Record<
  TelemetryProducerError['code'],
  { status: 400 | 409 | 503; error: string }
>;

function refusal(c: Context, error: unknown): Response {
  if (error instanceof TelemetryProducerError) {
    const { status, error: text } = REFUSALS[error.code];
    return c.json({ success: false, error: text, code: error.code }, status);
  }
  throw error;
}

const invalidBody = (c: Context) =>
  c.json(
    {
      success: false,
      error:
        'Body is { name: string, allowRemote?: boolean, expiresInDays?: number | null }.',
      code: 'invalid_request',
    },
    400,
  );

/**
 * Telemetry producer management, mounted at `/api/telemetry-producers`. The
 * route table gates the mount at `access:manage`; `isOperator` then refuses
 * every caller but the Station operator, because a producer token is a
 * standing credential that writes into the operator's monitoring history.
 */
export function createTelemetryProducerRoutes(options: {
  store: TelemetryProducerStore;
  isOperator: (c: Context) => boolean;
  /** The caller's principal id, recorded as the new producer's owner. */
  resolvePrincipalId: (c: Context) => string | undefined;
}): Hono {
  const { store } = options;
  const app = new Hono();
  const operatorOnly =
    (handle: (c: Context) => Response | Promise<Response>) =>
    (c: Context): Response | Promise<Response> => {
      c.header('Cache-Control', 'no-store');
      if (!options.isOperator(c))
        return c.json(
          {
            success: false,
            error: 'Only the Station operator can manage telemetry producers.',
            code: 'operator_required',
          },
          403,
        );
      return handle(c);
    };

  app.get(
    '/',
    operatorOnly((c) => {
      try {
        return c.json({
          success: true,
          data: {
            producers: store.list().map((producer) => project(store, producer)),
          },
        });
      } catch (error) {
        return refusal(c, error);
      }
    }),
  );

  app.post(
    '/',
    operatorOnly(async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return invalidBody(c);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        return invalidBody(c);
      const input = body as Record<string, unknown>;
      const allowed = new Set(['name', 'allowRemote', 'expiresInDays']);
      if (
        Object.keys(input).some((key) => !allowed.has(key)) ||
        typeof input.name !== 'string' ||
        (input.allowRemote !== undefined &&
          typeof input.allowRemote !== 'boolean') ||
        (input.expiresInDays !== undefined &&
          input.expiresInDays !== null &&
          typeof input.expiresInDays !== 'number')
      )
        return invalidBody(c);
      const ownerPrincipalId = options.resolvePrincipalId(c);
      if (!ownerPrincipalId)
        return c.json(
          {
            success: false,
            error: 'Only the Station operator can manage telemetry producers.',
            code: 'operator_required',
          },
          403,
        );
      try {
        const created = await store.create({
          ownerPrincipalId,
          name: input.name,
          allowRemote: input.allowRemote === true,
          expiresInDays:
            typeof input.expiresInDays === 'number'
              ? input.expiresInDays
              : null,
        });
        return c.json(
          {
            success: true,
            data: {
              producer: project(store, created.producer),
              // Shown once. Station keeps only its hash.
              token: created.secret,
            },
          },
          201,
        );
      } catch (error) {
        return refusal(c, error);
      }
    }),
  );

  app.delete(
    '/:name',
    operatorOnly(async (c) => {
      const name = c.req.param('name') ?? '';
      try {
        if (!(await store.revoke(name)))
          return c.json(
            {
              success: false,
              error: 'No telemetry producer has that name.',
              code: 'not_found',
            },
            404,
          );
        return c.json({ success: true, data: { revoked: name } });
      } catch (error) {
        return refusal(c, error);
      }
    }),
  );

  return app;
}
