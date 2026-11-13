import { randomUUID } from 'node:crypto';
import type { ConnectionUsedBy } from '@kontourai/station-contracts/connection-used-by';
import type { EngineAllowanceEvidence } from '@kontourai/station-contracts/engine-accounts';
import { pairingScopeIncludes } from '@kontourai/station-contracts/environment-security';
import type {
  ConnectionConfig,
  EngineRouteObservation,
} from '@kontourai/station-contracts/tool';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import {
  isOperatorInPersonNotAgent,
  requestMayBeAnAgent,
} from '../../security/coding-authority.js';
import {
  isManagedEngineRefusal,
  managedEngineRefusalBody,
} from '../../security/managed-engine-limits.js';
import { grantedPairingScope } from '../../security/pairing-route-scopes.js';
import {
  ConnectionAlreadyExistsError,
  type ConnectionService,
  ModelSelectionRequiredError,
} from '../../services/connections/connection-service.js';
import { allowanceEvidenceForViewer } from '../../services/connections/engine-allowance-evidence.js';
import { routeObservationForViewer } from '../../services/connections/engine-route-observation.js';
import { boundFleetContributionManifest } from '../../services/inference/fleet-inference-service.js';
import {
  connectionSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import {
  redactConnectionSecrets,
  restoreConnectionSecrets,
} from './provider-secrets.js';

export function createConnectionRoutes(
  connectionService: ConnectionService,
  options: {
    applyConfigurationMutation?: AgentConfigurationMutationRunner;
    /**
     * What names each connection (`GET /used-by`), as this caller may see
     * it. `'withheld'` for a caller that receives no operator Agent catalog:
     * the answer lists Agents and Projects by slug.
     */
    readUsedBy?: (c: Context) => Promise<ConnectionUsedBy | 'withheld'>;
  } = {},
) {
  const app = new Hono();

  const mutate = <T>(operation: () => Promise<T>) =>
    captureConfigurationMutation(
      options.applyConfigurationMutation,
      async (beginMutation) => {
        // The registry is the connection/default identity commit authority.
        // Do not schedule a reload for a rejected or merely prepared write.
        const result = await operation();
        beginMutation();
        return result;
      },
    );

  const saveConnection = (
    config: ConnectionConfig,
    options?: { createOnly?: boolean },
  ) => mutate(() => connectionService.saveConnection(config, options));

  const saveErrorPayload = (error: unknown) => ({
    success: false as const,
    error: errorMessage(error),
    ...(error instanceof ModelSelectionRequiredError
      ? { modelOptions: error.modelOptions }
      : {}),
  });

  app.get('/', async (c) => {
    try {
      const data = await connectionService.listConnections();
      return c.json({
        success: true,
        data: forViewer(c, data).map(redactConnectionSecrets),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * archive#3748: `failures` is always present, and it is the difference
   * between "you have no model connections" and "Station could not read
   * them". A row that throws costs itself and names itself; the rest of the
   * inventory still reaches the picker, the Create gate and status.
   */
  app.get('/models', async (c) => {
    try {
      const { connections, failures } =
        await connectionService.listModelConnectionInventory();
      return c.json({
        success: true,
        data: connections.map(redactConnectionSecrets),
        failures,
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/agents', async (c) => {
    try {
      const { connections, failures } =
        await connectionService.listRuntimeConnectionInventory({
          withAllowanceEvidence: true,
        });
      return c.json({
        success: true,
        data: forViewer(c, connections),
        failures,
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/agents/catalog', async (c) => {
    try {
      const data = await connectionService.listRuntimeConnectionCatalog({
        withAllowanceEvidence: true,
      });
      return c.json({ success: true, data: forViewer(c, data) });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * archive#1398 §5.3 / §10 OQ-2 — the CONTRIBUTED-SUBSET projection, gated
   * at `inference:invoke`.
   *
   * This endpoint used to return every model this Station can launch. Both
   * halves of the recorded decision ship together, and shipping only the
   * scope half would have been worse than shipping neither: raising the tier
   * to `inference:invoke` hands the full enumeration to precisely the
   * fleet-peer class the completion route's refusal parity exists to keep
   * from learning what this Station has but has NOT contributed. A peer that
   * cannot discover a withheld model through `POST /api/inference/completions`
   * must not be able to read the whole list here.
   *
   * So the payload is now `station.fleet-contribution/v1` — the same
   * disclosure surface as `GET /api/inference/manifest`, from the same
   * projection. The schema version is the honest signal that this is a
   * different thing than it was; a consumer branching on `schemaVersion` sees
   * the change rather than silently reading a shorter list. Nothing in this
   * repo called it (the SDK's two exported functions had zero call sites),
   * and `docs/reference/api.md` records the change for out-of-repo embedders.
   *
   * archive#2051 retires the former tunnel-disclosure residue: like every
   * protected route, this read rejects a bare loopback or SSH-forwarded
   * request with `401 authentication_required`. The contributed subset remains
   * the only credentialed HTTP projection; the un-projected inventory is
   * in-process only.
   *
   * The un-projected inventory has NOT become unreachable to the code that
   * needs it: the conversation/context-window path reads the cached inventory
   * accessor in-process, and the manifest projection builds the inventory.
   * What is gone is the remote HTTP read of it.
   */
  app.get('/model-inventory', async (c) => {
    try {
      const data = boundFleetContributionManifest(
        await connectionService.getFleetContributionManifest(),
      );
      return c.json({ success: true, data });
    } catch {
      return c.json(
        {
          success: false,
          error: 'Failed to project the contributed model manifest',
        },
        500,
      );
    }
  });

  // Registered before `/:id`, which would otherwise read `used-by` as an id.
  app.get('/used-by', async (c) => {
    if (!options.readUsedBy)
      return c.json(
        { success: false, error: 'Used-by is not available on this Station' },
        501,
      );
    try {
      const usedBy = await options.readUsedBy(c);
      c.header('Cache-Control', 'no-store');
      if (usedBy === 'withheld')
        return c.json(
          {
            success: false,
            error: 'What uses a connection is shown to the operator only',
          },
          403,
        );
      return c.json({ success: true, data: usedBy });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/:id', async (c) => {
    try {
      // The engine page reads its engine here, so it carries the same
      // evidence and viewer rules as the engine listings.
      const connection = await connectionService.getConnection(param(c, 'id'), {
        withAllowanceEvidence: true,
      });
      if (!connection) {
        return c.json({ success: false, error: 'Connection not found' }, 404);
      }
      const [shown] = forViewer(c, [connection]);
      return c.json({
        success: true,
        data: redactConnectionSecrets(shown ?? connection),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/:id/quota', async (c) => {
    try {
      const data = await connectionService.readQuotaSnapshot(param(c, 'id'));
      return c.json(data);
    } catch (error: unknown) {
      const message = errorMessage(error);
      return c.json(
        { success: false, error: message },
        /not found/i.test(message) ? 404 : 500,
      );
    }
  });

  app.post('/', validate(connectionSchema), async (c) => {
    try {
      const body = getBody(c) as ConnectionConfig;
      const mutation = await saveConnection(
        restoreConnectionSecrets({
          ...body,
          id: body.id || randomUUID(),
        }),
        { createOnly: true },
      );
      return c.json(
        {
          success: true,
          data: redactConnectionSecrets(mutation.value),
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 201),
      );
    } catch (error: unknown) {
      if (isManagedEngineRefusal(error))
        return c.json(managedEngineRefusalBody(error), 403);
      return c.json(
        saveErrorPayload(error),
        error instanceof ConnectionAlreadyExistsError ? 409 : 400,
      );
    }
  });

  app.put('/:id', validate(connectionSchema), async (c) => {
    try {
      const body = getBody(c) as ConnectionConfig;
      const id = param(c, 'id');
      const existing = await connectionService.getConnection(id);
      const mutation = await saveConnection(
        restoreConnectionSecrets({ ...body, id }, existing),
      );
      return c.json(
        {
          success: true,
          data: redactConnectionSecrets(mutation.value),
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (isManagedEngineRefusal(error))
        return c.json(managedEngineRefusalBody(error), 403);
      return c.json(saveErrorPayload(error), 400);
    }
  });

  app.delete('/:id', async (c) => {
    try {
      const id = param(c, 'id');
      const mutation = await mutate(() =>
        connectionService.deleteConnection(id),
      );
      return c.json(
        {
          success: true,
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:id/test', async (c) => {
    try {
      const data = await connectionService.testConnection(param(c, 'id'));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      const message = errorMessage(error);
      const status = /not found/i.test(message) ? 404 : 400;
      return c.json({ success: false, error: message }, status);
    }
  });

  app.post('/:id/smoke', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        confirmed?: unknown;
        timeoutMs?: unknown;
      };
      const data = await connectionService.smokeConnection(param(c, 'id'), {
        confirmed: body.confirmed === true,
        ...(typeof body.timeoutMs === 'number'
          ? { timeoutMs: body.timeoutMs }
          : {}),
      });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      const message = errorMessage(error);
      const status = /not found/i.test(message) ? 404 : 400;
      return c.json({ success: false, error: message }, status);
    }
  });

  return app;
}

/**
 * These lists are readable at `orchestration:read`, but two things on them
 * are for the operator in person or a non-agent viewer granted
 * `access:manage`:
 *
 * - #4710: an endpoint from Station's environment or the managed policy is
 *   host configuration, so others do not read its origin.
 * - Recorded quota refusals are Station-wide, but which saved account a
 *   refusal ran on is credential management, so others read the refusal
 *   without the account.
 */
function forViewer<
  T extends {
    routeObservation?: EngineRouteObservation;
    allowanceEvidence?: EngineAllowanceEvidence[];
  },
>(c: Context, connections: readonly T[]): T[] {
  const scope = grantedPairingScope(c);
  // An agent's request never reads host endpoints or the refused account,
  // whatever scope its credential carries.
  const mayRead =
    isOperatorInPersonNotAgent(c.req.raw) ||
    (!requestMayBeAnAgent(c.req.raw) &&
      scope !== undefined &&
      pairingScopeIncludes(scope, 'access:manage'));
  return connections.map((connection) => ({
    ...connection,
    ...(connection.routeObservation
      ? {
          routeObservation: routeObservationForViewer(
            connection.routeObservation,
            mayRead,
          ),
        }
      : {}),
    ...(connection.allowanceEvidence
      ? {
          allowanceEvidence: allowanceEvidenceForViewer(
            connection.allowanceEvidence,
            mayRead,
          ),
        }
      : {}),
  }));
}
