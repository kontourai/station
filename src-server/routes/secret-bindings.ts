import { Hono } from 'hono';
import type {
  SecretBindingAdministration,
  SecretBindingIntegrationAdministration,
  SecretBindingIntegrationOutcome,
} from '../services/secrets/secret-binding-administration.js';
import {
  SECRET_BINDING_CONFLICT_MESSAGE,
  SecretBindingConflictError,
} from '../services/secrets/secret-binding-administration.js';

/** Operator-only mount; runtime composition owns its access:manage gate. */
export function createSecretBindingRoutes(
  service: SecretBindingAdministration,
  consumers?: SecretBindingIntegrationAdministration,
  migration?: {
    migrateStoredEnv(input: {
      integrationId: string;
      bindings: Record<string, { bindingId: string; expectedRevision: number }>;
    }): Promise<{ outcome: 'migrated'; migratedEnvNames: string[] }>;
  },
) {
  const app = new Hono();
  app.get('/integrations/:integrationId', async (c) => {
    if (!consumers)
      return c.json(
        {
          success: false,
          error: 'Secret binding consumer service unavailable.',
        },
        503,
      );
    return respond(c, () =>
      consumers.getIntegrationBindings({
        integrationId: c.req.param('integrationId'),
      }),
    );
  });
  app.get('/', async (c) =>
    c.json({ success: true, data: await service.list() }),
  );
  app.get('/:id', async (c) => {
    const binding = await service.get(c.req.param('id'));
    return binding
      ? c.json({ success: true, data: binding })
      : c.json({ success: false, error: 'Secret binding not found.' }, 404);
  });
  app.post('/', async (c) =>
    respond(
      c,
      async () =>
        service.create(
          (await body(c)) as Parameters<
            SecretBindingAdministration['create']
          >[0],
        ),
      201,
    ),
  );
  app.put('/:id', async (c) =>
    respond(c, async () =>
      service.replace({
        ...(await body(c)),
        id: c.req.param('id'),
      } as Parameters<SecretBindingAdministration['replace']>[0]),
    ),
  );
  app.post('/:id/revoke', async (c) =>
    respond(c, async () =>
      service.revoke({
        ...(await body(c)),
        id: c.req.param('id'),
      } as Parameters<SecretBindingAdministration['revoke']>[0]),
    ),
  );
  app.post('/:id/bind', async (c) =>
    respondConsumer(c, consumers, 'bind', c.req.param('id')),
  );
  app.post('/:id/unbind', async (c) =>
    respondConsumer(c, consumers, 'unbind', c.req.param('id')),
  );
  const migrateStoredEnv = async (c: any, integrationId: string) => {
    if (!migration)
      return c.json(
        { success: false, error: 'Secret binding migration unavailable.' },
        503,
      );
    return respond(c, async () => {
      const input = await body(c);
      return migration.migrateStoredEnv({
        integrationId,
        bindings: input.bindings as Record<
          string,
          { bindingId: string; expectedRevision: number }
        >,
      });
    });
  };
  // The migration is keyed by the integration, not by a secret binding. Keep
  // the earlier route as a compatibility alias while all new callers use the
  // unambiguous integration segment.
  app.post('/integrations/:integrationId/migrate-stored-env', (c) =>
    migrateStoredEnv(c, c.req.param('integrationId')),
  );
  app.post('/:integrationId/migrate-stored-env', (c) =>
    migrateStoredEnv(c, c.req.param('integrationId')),
  );
  return app;
}

async function respondConsumer(
  c: any,
  consumers: SecretBindingIntegrationAdministration | undefined,
  operation: 'bind' | 'unbind',
  id: string,
) {
  if (!consumers)
    return c.json(
      { success: false, error: 'Secret binding consumer service unavailable.' },
      503,
    );
  return respond(
    c,
    async () => {
      const input = await body(c);
      return consumers[operation]({
        id,
        integrationId: input.integrationId as string,
        envName: input.envName as string,
        expectedRevision: input.expectedRevision as number,
      });
    },
    200,
    true,
  );
}

async function body(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A JSON object is required.');
  return value as Record<string, unknown>;
}
async function respond(
  c: any,
  action: () => Promise<unknown>,
  status = 200,
  partialAware = false,
) {
  try {
    const data = await action();
    const partial =
      partialAware &&
      (data as SecretBindingIntegrationOutcome).outcome === 'safe-partial';
    return c.json({ success: true, data }, partial ? 202 : status);
  } catch (error) {
    const failure = secretBindingRouteFailure(error);
    return c.json(
      {
        success: false,
        error: failure.error,
      },
      failure.status,
    );
  }
}

/**
 * The route exposes only typed, stable refusal copy. An Error's `message` is
 * mutable and can originate in storage or an integration, so it is never an
 * outward contract — even for the one conflict type whose public outcome is
 * intentionally specific.
 */
function secretBindingRouteFailure(error: unknown): {
  status: 400 | 409;
  error: string;
} {
  return error instanceof SecretBindingConflictError
    ? { status: 409, error: SECRET_BINDING_CONFLICT_MESSAGE }
    : { status: 400, error: 'Invalid secret binding request.' };
}
