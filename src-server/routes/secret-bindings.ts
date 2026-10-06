import type { SecretBindingGrant } from '@kontourai/station-contracts/secret-binding';
import { type Context, Hono } from 'hono';
import type {
  SecretBindingAdministration,
  SecretBindingIntegrationAdministration,
  SecretBindingIntegrationOutcome,
  SecretBindingViewer,
} from '../services/secrets/secret-binding-administration.js';
import {
  SECRET_BINDING_CONFLICT_MESSAGE,
  SECRET_BINDING_NOT_FOUND_MESSAGE,
  SECRET_BINDING_PERSON_CREATE_MESSAGE,
  SECRET_BINDING_PERSON_GRANT_MESSAGE,
  SecretBindingConflictError,
  SecretBindingNotFoundError,
  SecretBindingPersonCreateError,
  SecretBindingPersonGrantError,
} from '../services/secrets/secret-binding-administration.js';
import { refuseUngrantedCommandChoice } from './working-directory-authority.js';

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
  /**
   * Whether an integration launches a command (stdio). A binding's value
   * becomes that command's environment, so attaching one, or changing the
   * value of one that is attached, is choosing a command. Absent or failing,
   * an integration counts as launching one.
   */
  integrationLaunches?: (integrationId: string) => Promise<boolean>,
  options: {
    /**
     * #3279: the calling request's own principal id. Bindings owned by a
     * person are listed, read, and changed only for that person; without a
     * resolvable caller only instance bindings are visible.
     */
    resolveViewerPrincipalId?: (c: Context) => string | undefined;
  } = {},
) {
  // Fails closed: a missing or malformed id, an unreadable integration or an
  // unwired lookup all count as launching a command.
  const launches = async (integrationId: unknown): Promise<boolean> =>
    typeof integrationId !== 'string' ||
    (integrationLaunches
      ? await integrationLaunches(integrationId).catch(() => true)
      : true);
  /** A 403 when the integration launches a command and the caller may not choose one. */
  const refuseIfLaunching = async (
    c: Context,
    integrationId: unknown,
  ): Promise<Response | undefined> =>
    (await launches(integrationId))
      ? refuseUngrantedCommandChoice(c)
      : undefined;
  const app = new Hono();
  const viewerOf = (c: Context): SecretBindingViewer | undefined => {
    const principalId = options.resolveViewerPrincipalId?.(c);
    return principalId ? { principalId } : undefined;
  };
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
    c.json({ success: true, data: await service.list(viewerOf(c)) }),
  );
  app.get('/:id', async (c) => {
    const binding = await service.get(c.req.param('id'), viewerOf(c));
    return binding
      ? c.json({ success: true, data: binding })
      : c.json(
          { success: false, error: SECRET_BINDING_NOT_FOUND_MESSAGE },
          404,
        );
  });
  app.post('/', async (c) =>
    respond(
      c,
      async () => {
        const input = await body(c);
        const viewer = viewerOf(c);
        // `owner: 'self'` is the only person-owned form; the owner is the
        // caller, never a principal named in the body.
        if (input.owner !== undefined && input.owner !== 'self')
          throw new Error('owner must be self when present.');
        if (input.projectSlug !== undefined && input.owner !== 'self')
          throw new Error('projectSlug requires owner self.');
        if (input.owner === 'self' && !viewer)
          throw new Error('The caller could not be identified.');
        return service.create({
          id: input.id as string,
          name: input.name as string,
          authRef: input.authRef,
          ...(input.owner === 'self' && viewer
            ? {
                owner:
                  typeof input.projectSlug === 'string'
                    ? {
                        kind: 'principal-project' as const,
                        principalId: viewer.principalId,
                        projectSlug: input.projectSlug,
                      }
                    : {
                        kind: 'principal' as const,
                        principalId: viewer.principalId,
                      },
              }
            : {}),
          ...(viewer ? { viewer } : {}),
        });
      },
      201,
    ),
  );
  app.put('/:id', async (c) => {
    // Replacing a binding changes the value every command it is bound to
    // receives, so it is gated when any of them launches one.
    let current: Awaited<ReturnType<SecretBindingAdministration['get']>>;
    try {
      current = await service.get(c.req.param('id'), viewerOf(c));
    } catch {
      // Unreadable grants can't be checked, so refuse an ungranted caller.
      const refused = refuseUngrantedCommandChoice(c);
      if (refused) return refused;
      current = null;
    }
    for (const grant of current?.grants ?? []) {
      const refused = await refuseIfLaunching(c, grant.integrationId);
      if (refused) return refused;
    }
    return respond(c, async () =>
      service.replace({
        ...(await body(c)),
        id: c.req.param('id'),
        viewer: viewerOf(c),
      } as Parameters<SecretBindingAdministration['replace']>[0]),
    );
  });
  app.post('/:id/revoke', async (c) =>
    respond(c, async () =>
      service.revoke({
        ...(await body(c)),
        id: c.req.param('id'),
        viewer: viewerOf(c),
      } as Parameters<SecretBindingAdministration['revoke']>[0]),
    ),
  );
  app.post('/:id/bind', async (c) =>
    respondBindingMutation(
      c,
      service,
      consumers,
      'bind',
      c.req.param('id'),
      refuseIfLaunching,
      viewerOf(c),
    ),
  );
  app.post('/:id/unbind', async (c) =>
    respondBindingMutation(
      c,
      service,
      consumers,
      'unbind',
      c.req.param('id'),
      refuseIfLaunching,
      viewerOf(c),
    ),
  );
  const migrateStoredEnv = async (c: any, integrationId: string) => {
    if (!migration)
      return c.json(
        { success: false, error: 'Secret binding migration unavailable.' },
        503,
      );
    // Migrating moves stored env into bindings on that integration: the same
    // attach, gated by the same decision.
    const refused = await refuseIfLaunching(c, integrationId);
    if (refused) return refused;
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

async function respondBindingMutation(
  c: any,
  service: SecretBindingAdministration,
  consumers: SecretBindingIntegrationAdministration | undefined,
  operation: 'bind' | 'unbind',
  id: string,
  refuseIfLaunching: (
    c: Context,
    integrationId: unknown,
  ) => Promise<Response | undefined>,
  viewer: SecretBindingViewer | undefined,
) {
  let input: Record<string, unknown>;
  try {
    input = await body(c);
  } catch (error) {
    return respond(c, async () => {
      throw error;
    });
  }
  if (input.kind !== 'acp-provider-header') {
    // Attaching a value to a command's environment chooses that command's
    // environment; detaching one only removes it.
    if (operation === 'bind') {
      const refused = await refuseIfLaunching(c, input.integrationId);
      if (refused) return refused;
    }
    return respondConsumer(c, consumers, operation, id, viewer, input);
  }
  const grant: SecretBindingGrant = {
    kind: 'acp-provider-header',
    connectionId: input.connectionId as string,
    providerId: input.providerId as string,
    headerName: input.headerName as string,
  };
  return respond(c, () =>
    service[operation === 'bind' ? 'grant' : 'ungrant']({
      id,
      grant,
      expectedRevision: input.expectedRevision as number,
      ...(viewer ? { viewer } : {}),
    }),
  );
}

async function respondConsumer(
  c: any,
  consumers: SecretBindingIntegrationAdministration | undefined,
  operation: 'bind' | 'unbind',
  id: string,
  viewer: SecretBindingViewer | undefined,
  parsedInput?: Record<string, unknown>,
) {
  if (!consumers)
    return c.json(
      { success: false, error: 'Secret binding consumer service unavailable.' },
      503,
    );
  return respond(
    c,
    async () => {
      const input = parsedInput ?? (await body(c));
      return consumers[operation]({
        id,
        integrationId: input.integrationId as string,
        envName: input.envName as string,
        expectedRevision: input.expectedRevision as number,
        ...(viewer ? { viewer } : {}),
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
 * outward contract — even for the typed outcomes whose public copy is
 * intentionally specific. Not found covers another person's binding too
 * (#3279), so the two responses are identical.
 */
function secretBindingRouteFailure(error: unknown): {
  status: 400 | 404 | 409;
  error: string;
} {
  if (error instanceof SecretBindingConflictError)
    return { status: 409, error: SECRET_BINDING_CONFLICT_MESSAGE };
  if (error instanceof SecretBindingNotFoundError)
    return { status: 404, error: SECRET_BINDING_NOT_FOUND_MESSAGE };
  if (error instanceof SecretBindingPersonGrantError)
    return { status: 400, error: SECRET_BINDING_PERSON_GRANT_MESSAGE };
  if (error instanceof SecretBindingPersonCreateError)
    return { status: 400, error: SECRET_BINDING_PERSON_CREATE_MESSAGE };
  return { status: 400, error: 'Invalid secret binding request.' };
}
