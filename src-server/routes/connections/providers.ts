/**
 * Provider Connection Routes
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import {
  createEmbeddingProvider,
  createLLMProvider,
  createVectorDbProvider,
} from '../../providers/connection-factories.js';
import { safeListModelCatalog } from '../../providers/llm/model-catalog.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import {
  type ProviderService,
  providerTypeLabel,
} from '../../services/connections/provider-service.js';
import { providerOps } from '../../telemetry/metrics.js';
import { assertBoundedJsonResponse } from '../chat/bounded-response.js';
import {
  errorMessage,
  getBody,
  param,
  providerSchema,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import {
  redactLegacyProviderSecrets,
  restoreLegacyProviderSecrets,
} from './provider-secrets.js';

/**
 * The classified check the rest of the product reads, named structurally so
 * these legacy routes can consult it without depending on the whole service
 * (archive#3654 review, M2).
 *
 * `testConnection` is the explicit, classified check — the same one the
 * connections UI and the CLI run, including the fallback chat probe that is
 * the only evidence a catalogue-less connection can produce. It belongs on a
 * POST and nowhere else.
 *
 * `getModelConnectionCheck` READS the standing receipt for one connection:
 * no provider is constructed, no request is made, no other connection is
 * touched (archive#3654 review round 2). The first version of this consulted the
 * whole model listing, which runs catalogue discovery against every
 * configured provider — a GET for one connection amplified into network
 * traffic to all of them, at a polling frequency no one here can see.
 */
export interface ProviderCheckAuthority {
  testConnection(id: string): Promise<{ healthy: boolean; reason?: string }>;
  getModelConnectionCheck(
    id: string,
  ): { status: string; reason?: string } | null;
}

export function createProviderRoutes(
  providerService: ProviderService,
  options: {
    applyConfigurationMutation?: AgentConfigurationMutationRunner;
    /**
     * Optional so an isolated composition (and the route tests that predate
     * this) still works: without it these routes answer from the provider's
     * own health boolean exactly as they always did.
     */
    connectionService?: ProviderCheckAuthority;
  } = {},
) {
  const app = new Hono();

  /**
   * The standing classified observation already recorded for THIS connection,
   * or `null` when nothing has observed its current configuration.
   *
   * A bare `healthCheck()` boolean is not the same question. Bedrock's is now
   * "did AWS answer with a catalogue", so an IAM identity allowed
   * `InvokeModel` and denied the listing — a connection an explicit test can
   * prove works, and whose pass is protected from being superseded by that
   * very catalogue answer — reported `healthy: false` here (archive#3654 review, M2).
   * Reading the receipt instead means these endpoints and the connections
   * surface answer from one derivation, and reading only THIS connection's
   * receipt means a targeted GET stays targeted.
   */
  const standingCheck = (id: string) => {
    if (!options.connectionService) return null;
    const check = options.connectionService.getModelConnectionCheck(id);
    if (!check || check.status === 'not-checked') return null;
    return {
      healthy: check.status === 'passed',
      status: check.status,
      ...(check.reason ? { reason: check.reason } : {}),
    };
  };
  const mutate = <T>(operation: (beginMutation: () => void) => Promise<T>) =>
    captureConfigurationMutation(options.applyConfigurationMutation, operation);

  app.get('/', async (c) => {
    try {
      providerOps.add(1, { op: 'list' });
      const data = await providerService.listProviderConnections();
      return c.json({
        success: true,
        data: data.map(redactLegacyProviderSecrets),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/', validate(providerSchema), async (c) => {
    try {
      const body = restoreLegacyProviderSecrets(
        getBody(c) as ProviderConnectionConfig,
      );
      const result = await mutate(async (beginMutation) => {
        const duplicate = providerService.findDuplicateConnection(
          body.type,
          body.config ?? {},
        );
        if (duplicate) return { kind: 'duplicate', duplicate } as const;
        if (!body.id) body.id = randomUUID();
        beginMutation();
        providerOps.add(1, { op: 'register' });
        await providerService.saveProviderConnection(body);
        return { kind: 'created', connection: body } as const;
      });
      if (result.value.kind === 'duplicate') {
        providerOps.add(1, { op: 'duplicate-rejected', type: body.type });
        return c.json(
          {
            success: false,
            error: `A connection to this ${providerTypeLabel(body.type)} server already exists: ${result.value.duplicate.name}`,
            existingId: result.value.duplicate.id,
          },
          409,
        );
      }
      return c.json(
        {
          success: true,
          data: redactLegacyProviderSecrets(result.value.connection),
          ...configurationActivationPayload(result.activation),
        },
        configurationMutationStatus(result.activation, 201),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.put('/:id', validate(providerSchema), async (c) => {
    try {
      const id = param(c, 'id');
      const body = getBody(c) as Omit<ProviderConnectionConfig, 'id'>;
      const result = await mutate(async (beginMutation) => {
        const existing = providerService
          .listProviderConnections()
          .find((connection) => connection.id === id);
        if (!existing) return { kind: 'missing' } as const;
        const connection = restoreLegacyProviderSecrets(
          { ...body, id } as ProviderConnectionConfig,
          existing,
        );
        if (isDeepStrictEqual(existing, connection)) {
          return { kind: 'unchanged', connection } as const;
        }
        beginMutation();
        await providerService.saveProviderConnection(connection);
        return { kind: 'updated', connection } as const;
      });
      if (result.value.kind === 'missing') {
        return c.json({ success: false, error: 'Provider not found' }, 404);
      }
      return c.json(
        {
          success: true,
          data: redactLegacyProviderSecrets(result.value.connection),
          ...configurationActivationPayload(result.activation),
        },
        configurationMutationStatus(result.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.delete('/:id', async (c) => {
    try {
      const id = param(c, 'id');
      providerOps.add(1, { op: 'delete' });
      const result = await mutate(async (beginMutation) => {
        const existing = providerService
          .listProviderConnections()
          .some((connection) => connection.id === id);
        if (!existing) return false;
        beginMutation();
        await providerService.deleteProviderConnection(id);
        return true;
      });
      if (!result.value) {
        return c.json({ success: false, error: 'Provider not found' }, 404);
      }
      return c.json(
        {
          success: true,
          ...configurationActivationPayload(result.activation),
        },
        configurationMutationStatus(result.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:id/test', async (c) => {
    try {
      const id = param(c, 'id');
      const connections = await providerService.listProviderConnections();
      const conn = connections.find((p) => p.id === id);
      if (!conn)
        return c.json({ success: false, error: 'Provider not found' }, 404);
      if (!conn.enabled || !conn.capabilities.includes('llm')) {
        return c.json(
          {
            success: false,
            error: 'Provider is not an enabled LLM connection',
          },
          400,
        );
      }

      const provider = createLLMProvider(conn);
      if (!provider)
        return c.json(
          {
            success: false,
            error: `No provider implementation for type: ${conn.type}`,
          },
          400,
        );

      // An explicit test is exactly what the connection service's classified
      // check is, chat fallback and all — running the bare health boolean here
      // instead answered a narrower question than the caller asked (archive#3654
      // review, M2).
      if (options.connectionService) {
        const outcome = await options.connectionService.testConnection(id);
        return c.json({
          success: true,
          data: {
            healthy: outcome.healthy,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          },
        });
      }
      const healthy = await providerService.checkHealth(provider, conn.type);
      return c.json({ success: true, data: { healthy } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/:id/health', async (c) => {
    try {
      const id = param(c, 'id');
      providerOps.add(1, { op: 'health' });
      const connections = await providerService.listProviderConnections();
      const conn = connections.find((p) => p.id === id);
      if (!conn)
        return c.json({ success: false, error: 'Provider not found' }, 404);

      const provider = createLLMProvider(conn);
      if (!provider)
        return c.json({
          success: true,
          data: {
            healthy: false,
            reason: `No implementation for type: ${conn.type}`,
          },
        });

      const classified = standingCheck(id);
      const healthy = classified
        ? classified.healthy
        : await providerService.checkHealth(provider, conn.type);
      return c.json({
        success: true,
        data: {
          healthy,
          type: conn.type,
          name: conn.name,
          // Additive: a boolean cannot tell "these settings were refused" from
          // "reachable, and nothing has proven it can run work yet".
          ...(classified
            ? {
                status: classified.status,
                ...(classified.reason ? { reason: classified.reason } : {}),
              }
            : {}),
        },
      });
    } catch (error: unknown) {
      return c.json({
        success: true,
        data: { healthy: false, reason: errorMessage(error) },
      });
    }
  });

  app.get('/:id/models', async (c) => {
    try {
      const id = param(c, 'id');
      const connections = await providerService.listProviderConnections();
      const conn = connections.find((p) => p.id === id);
      if (!conn)
        return c.json({ success: false, error: 'Provider not found' }, 404);
      if (!conn.enabled || !conn.capabilities.includes('llm')) {
        return c.json(
          {
            success: false,
            error: 'Provider is not an enabled LLM connection',
          },
          400,
        );
      }

      const provider = createLLMProvider(conn);
      if (!provider)
        return c.json(
          {
            success: false,
            error: `No provider implementation for type: ${conn.type}`,
          },
          400,
        );

      const configuredModel =
        typeof conn.config.defaultModel === 'string'
          ? conn.config.defaultModel.trim()
          : '';
      const catalog = await safeListModelCatalog(
        provider,
        configuredModel ? [{ id: configuredModel, name: configuredModel }] : [],
        undefined,
        c.req.raw.signal,
      );
      return c.json(
        assertBoundedJsonResponse(
          { success: true, data: catalog.models },
          'Provider model catalog',
        ),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/:id/test-embedding', async (c) => {
    try {
      const id = param(c, 'id');
      const connections = await providerService.listProviderConnections();
      const conn = connections.find((p) => p.id === id);
      if (!conn)
        return c.json({ success: false, error: 'Provider not found' }, 404);
      const provider = createEmbeddingProvider(conn);
      if (!provider)
        return c.json(
          {
            success: false,
            error: `No embedding implementation for type: ${conn.type}`,
          },
          400,
        );
      // Plugin-provided embedding providers are not required to expose a
      // health probe. Treating an absent probe as healthy turns a missing
      // observation into a credential verdict.
      const healthy = provider.healthCheck
        ? await provider.healthCheck()
        : null;
      return c.json({ success: true, data: { healthy } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/:id/test-vectordb', async (c) => {
    try {
      const id = param(c, 'id');
      const connections = await providerService.listProviderConnections();
      const conn = connections.find((p) => p.id === id);
      if (!conn)
        return c.json({ success: false, error: 'Provider not found' }, 404);
      const provider = createVectorDbProvider(conn);
      if (!provider)
        return c.json(
          {
            success: false,
            error: `No vectordb implementation for type: ${conn.type}`,
          },
          400,
        );
      const healthy = await provider
        .namespaceExists('__health-check')
        .then(() => true)
        .catch(() => false);
      return c.json({ success: true, data: { healthy } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
