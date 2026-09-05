import { isDeepStrictEqual } from 'node:util';
import {
  type ACPConnectionConfig,
  type ACPConnectionRegistryEntry,
  ACPStatus,
} from '@kontourai/station-contracts/acp';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { Hono } from 'hono';
import {
  loadOrCreateAgentRegistry,
  materializeEngineAgent,
  registerEngineConnection,
  unregisterEngineConnection,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { listProviders } from '../../providers/registries/registry.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { ACPProviderRouteValidationError } from '../../services/acp/acp-process.js';
import {
  type IntegrationSecretResolution,
  SecretBindingResolutionError,
} from '../../services/secrets/secret-binding-administration.js';
import { acpOps } from '../../telemetry/metrics.js';
import {
  acpConnectionSchema,
  acpDisableProviderSchema,
  acpSetProviderSchema,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationMutationResponse,
} from '../system/configuration-activation.js';

function getProviderConnections(): ACPConnectionConfig[] {
  return listProviders('acpConnections').flatMap((entry: any) =>
    (entry.provider.getConnections?.() || []).map((conn: any) => ({
      ...conn,
      source: 'plugin' as const,
    })),
  );
}

function mergeACPConnections(
  configConnections: ACPConnectionConfig[],
  providerConnections: ACPConnectionConfig[],
): ACPConnectionConfig[] {
  const configIds = new Set(
    configConnections.map((connection) => connection.id),
  );
  return [
    ...configConnections,
    ...providerConnections.filter(
      (connection) => !configIds.has(connection.id),
    ),
  ];
}

/**
 * Registry entries whose command Station observed on the host but which have
 * no ACP connection yet (neither user-authored nor plugin-provided). Keyed on
 * the ACP connection id, because a connected ACP Engine reports the generic
 * `engineId: 'acp'` in `listEngineConnectionStates` and can never be matched
 * against a registry id that way (station#1548). Read-only: nothing here
 * launches the command.
 */
export async function listDetectedUnconnectedACPRegistryEntries(configLoader: {
  loadACPConfig: () => Promise<{ connections: ACPConnectionConfig[] }>;
}): Promise<Array<{ id: string; name: string }>> {
  return getRegistryEntries(await installedACPConnections(configLoader))
    .filter((entry) => entry.detected === true && !entry.installed)
    .map((entry) => ({ id: entry.id, name: entry.name }));
}

/**
 * The connections that count as installed for every registry projection
 * (onboarding, Add engine, GET /connections): user config plus plugin-provided
 * connections, minus any whose engine identity is not registered. The install
 * route saves config BEFORE the identity CAS, so a failed commit leaves a
 * config entry that is retryable but not an installed Engine; counting it as
 * installed hid it from every repair surface at once (station#1548 review).
 * Transport-only contexts (no filesystem loader, test fixtures) carry no
 * identity evidence and keep the legacy reading: every config entry counts.
 */
async function installedACPConnections(configLoader: {
  loadACPConfig: () => Promise<{ connections: ACPConnectionConfig[] }>;
}): Promise<ACPConnectionConfig[]> {
  const config = await configLoader.loadACPConfig();
  const registeredIds = await registeredRuntimeConnectionIds(configLoader);
  return mergeACPConnections(
    config.connections,
    getProviderConnections(),
  ).filter((connection) =>
    isRegisteredRuntimeConnection(connection.id, registeredIds),
  );
}

function getRegistryEntries(
  installedConnections: ACPConnectionConfig[],
): ACPConnectionRegistryEntry[] {
  const installedSources = new Map<string, 'user' | 'plugin'>();
  for (const connection of installedConnections) {
    if (!installedSources.has(connection.id)) {
      installedSources.set(
        connection.id,
        connection.source === 'plugin' ? 'plugin' : 'user',
      );
    }
  }

  const entriesById = new Map<string, ACPConnectionRegistryEntry>();
  for (const entry of listProviders('acpConnectionRegistry')) {
    const source = entry.builtin ? 'core' : 'plugin';
    const available = entry.provider.listAvailable?.() || [];
    for (const registryEntry of available) {
      entriesById.set(registryEntry.id, {
        ...registryEntry,
        source,
        sourceName: registryEntry.sourceName ?? entry.source,
        installed: installedSources.has(registryEntry.id),
        installedSource: installedSources.get(registryEntry.id),
      });
    }
  }
  return Array.from(entriesById.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function findRegistryEntry(
  id: string,
  installedConnections: ACPConnectionConfig[],
): ACPConnectionRegistryEntry | null {
  return (
    getRegistryEntries(installedConnections).find((entry) => entry.id === id) ??
    null
  );
}

const ACP_PROVIDER_ROUTE_PUBLIC_ERRORS = Object.freeze({
  observation_required:
    'Provider routing must be observed before it can be changed.',
  provider_not_found:
    'The requested ACP provider was not advertised by this agent.',
  protocol_unsupported:
    'The requested protocol was not advertised for this ACP provider.',
});

function acpProviderRoutePublicError(
  error: ACPProviderRouteValidationError,
): string {
  return ACP_PROVIDER_ROUTE_PUBLIC_ERRORS[error.code];
}

function normalizeACPConnection(value: Record<string, any>) {
  return {
    id: value.id,
    name: value.name,
    command: value.command,
    args: value.args ?? [],
    icon: value.icon ?? '🔌',
    enabled: value.enabled !== false,
    ...(value.cwd ? { cwd: value.cwd } : {}),
    ...(value.interactive !== undefined
      ? { interactive: value.interactive }
      : {}),
    ...(value.provideToolServers
      ? { provideToolServers: value.provideToolServers }
      : {}),
  };
}

async function registerPersistedACPConnection(
  ctx: RuntimeContext,
  id: string,
  name: string = id,
): Promise<Awaited<ReturnType<typeof materializeEngineAgent>> | undefined> {
  // Transport-only route fixtures do not expose a filesystem loader. Real
  // runtime contexts do, and therefore always take the durable identity path.
  if (typeof (ctx.configLoader as any).getProjectHomeDir !== 'function') return;
  await registerEngineConnection(
    ctx.configLoader as ConfigLoader,
    engineConnectionId(id),
    { kind: 'user-acp' },
  );
  return materializeEngineAgent(ctx.configLoader as ConfigLoader, id, name);
}

/**
 * The receipt names the Agent the install materialized or adopted. The
 * install is already committed by the time this reads the file; an adopted
 * Agent can be selected while its file is mid-write (materializeEngineAgent
 * tolerates that), so an unreadable file must not turn a committed install
 * into a 500 — the slug alone is still an honest receipt.
 */
async function installedAgentReceipt(
  configLoader: ConfigLoader,
  slug: string,
): Promise<Record<string, unknown>> {
  try {
    return { slug, ...(await configLoader.loadAgent(slug)) };
  } catch {
    return { slug };
  }
}

async function unregisterPersistedACPConnection(
  ctx: RuntimeContext,
  id: string,
): Promise<void> {
  if (typeof (ctx.configLoader as any).getProjectHomeDir !== 'function') return;
  await unregisterEngineConnection(
    ctx.configLoader as ConfigLoader,
    engineConnectionId(id),
  );
}

function isRegisteredRuntimeConnection(
  id: string,
  registeredIds: Set<string> | null,
): boolean {
  return registeredIds === null || registeredIds.has(id);
}

async function registeredRuntimeConnectionIds(configLoader: {
  loadACPConfig?: unknown;
  getProjectHomeDir?: unknown;
}): Promise<Set<string> | null> {
  if (typeof (configLoader as any).getProjectHomeDir !== 'function') {
    return null;
  }
  const registry = await loadOrCreateAgentRegistry(
    configLoader as ConfigLoader,
  );
  return new Set(registry.engineConnections.map(({ id }) => String(id)));
}

export function createACPRoutes(ctx: RuntimeContext) {
  const app = new Hono();

  app.get('/status', (c) => {
    return c.json({ success: true, data: ctx.acpBridge.getStatus() });
  });

  app.get('/connections', async (c) => {
    const allConnections = await installedACPConnections(ctx.configLoader);
    const status = ctx.acpBridge.getStatus();
    const connections = allConnections.map((cfg) => ({
      ...cfg,
      ...(status.connections.find((s) => s.id === cfg.id) || {
        status: ACPStatus.UNAVAILABLE,
        modes: [],
        sessionId: null,
        mcpServers: [],
      }),
    }));
    return c.json({ success: true, data: connections });
  });

  app.get('/registry', async (c) => {
    const entries = getRegistryEntries(
      await installedACPConnections(ctx.configLoader),
    );
    return c.json({ success: true, data: entries });
  });

  app.post('/registry/:id/install', async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const id = param(c, 'id');
          const config = await ctx.configLoader.loadACPConfig();
          const providerConns = getProviderConnections();
          if (providerConns.some((conn) => conn.id === id)) {
            return c.json(
              { success: false, error: `Connection '${id}' already exists` },
              409,
            );
          }

          const entry = findRegistryEntry(id, [
            ...config.connections,
            ...providerConns,
          ]);
          if (!entry) {
            return c.json(
              {
                success: false,
                error: `Engine registry entry '${id}' not found`,
              },
              404,
            );
          }

          const newConn = normalizeACPConnection({
            id: entry.id,
            name: entry.name,
            command: entry.command,
            args: entry.args || [],
            icon: entry.icon || '🔌',
            cwd: entry.cwd,
            enabled: true,
            interactive: entry.interactive,
          });
          const existing = config.connections.find((conn) => conn.id === id);
          if (existing && !isDeepStrictEqual(existing, newConn)) {
            return c.json(
              { success: false, error: `Connection '${id}' already exists` },
              409,
            );
          }
          if (!existing) config.connections.push(newConn);
          // Durable ACP config first, then the identity/default CAS. A failed
          // CAS deliberately leaves retryable config that remains invisible.
          await ctx.configLoader.saveACPConfig(config);
          const agent = await registerPersistedACPConnection(
            ctx,
            newConn.id,
            newConn.name,
          );
          beginMutation();
          await ctx.acpBridge.addConnection(newConn);
          acpOps.add(1, { op: 'create' });
          return c.json({
            success: true,
            data: newConn,
            ...(agent
              ? {
                  agent: {
                    data: await installedAgentReceipt(
                      ctx.configLoader as ConfigLoader,
                      agent.slug,
                    ),
                    created: agent.created,
                  },
                }
              : {}),
          });
        },
      ),
    );
  });

  app.post('/connections', validate(acpConnectionSchema), async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const body = getBody(c);
          if (!body.id || !body.command) {
            return c.json(
              { success: false, error: 'id and command are required' },
              400,
            );
          }
          const config = await ctx.configLoader.loadACPConfig();
          const newConn = normalizeACPConnection({
            id: body.id,
            name: body.name || body.id,
            command: body.command,
            args: body.args || [],
            icon: body.icon || '🔌',
            cwd: body.cwd,
            enabled: body.enabled !== false,
            ...(body.provideToolServers
              ? { provideToolServers: body.provideToolServers }
              : {}),
          });
          const existing = config.connections.find(
            (connection) => connection.id === newConn.id,
          );
          if (existing && !isDeepStrictEqual(existing, newConn)) {
            return c.json(
              {
                success: false,
                error: `Connection '${body.id}' already exists`,
              },
              409,
            );
          }
          if (!existing) {
            config.connections.push(newConn);
            await ctx.configLoader.saveACPConfig(config);
          }
          await registerPersistedACPConnection(ctx, newConn.id, newConn.name);
          beginMutation();
          if (newConn.enabled) await ctx.acpBridge.addConnection(newConn);
          acpOps.add(1, { op: 'create' });
          return c.json({ success: true, data: newConn });
        },
      ),
    );
  });

  app.put(
    '/connections/:id',
    validate(acpConnectionSchema.partial()),
    async (c) => {
      return configurationMutationResponse(
        await captureConfigurationMutation(
          ctx.applyAgentConfigurationMutation,
          async (beginMutation) => {
            const id = param(c, 'id');
            const body = getBody(c);
            const config = await ctx.configLoader.loadACPConfig();
            const idx = config.connections.findIndex((conn) => conn.id === id);
            if (idx === -1)
              return c.json(
                { success: false, error: 'Connection not found' },
                404,
              );
            const previous = config.connections[idx];
            const next = { ...previous, ...body, id };
            if (isDeepStrictEqual(previous, next)) {
              return c.json({ success: true, data: previous });
            }
            config.connections[idx] = next;
            await ctx.configLoader.saveACPConfig(config);
            await registerPersistedACPConnection(ctx, id, next.name);
            beginMutation();
            await ctx.acpBridge.removeConnection(id);
            if (next.enabled) await ctx.acpBridge.addConnection(next);
            acpOps.add(1, { op: 'update' });
            return c.json({ success: true, data: config.connections[idx] });
          },
        ),
      );
    },
  );

  app.delete('/connections/:id', async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const id = param(c, 'id');
          const config = await ctx.configLoader.loadACPConfig();
          if (!config.connections.some((conn) => conn.id === id)) {
            return c.json(
              { success: false, error: 'Connection not found' },
              404,
            );
          }
          // Registry removal first means a following config-write failure
          // leaves only retryable, non-authoritative ACP data on disk.
          await unregisterPersistedACPConnection(ctx, id);
          config.connections = config.connections.filter(
            (conn) => conn.id !== id,
          );
          await ctx.configLoader.saveACPConfig(config);
          beginMutation();
          await ctx.acpBridge.removeConnection(id);
          acpOps.add(1, { op: 'delete' });
          return c.json({ success: true });
        },
      ),
    );
  });

  app.post('/connections/:id/reconnect', async (c) => {
    const id = param(c, 'id');
    const result = await ctx.acpBridge.reconnect(id);
    return c.json({ success: result });
  });

  app.post(
    '/connections/:id/providers/set',
    validate(acpSetProviderSchema),
    async (c) => {
      const id = param(c, 'id');
      const body = getBody(c);
      let resolution: IntegrationSecretResolution | undefined;
      try {
        ctx.acpBridge.assertProviderSupported(
          id,
          body.providerId,
          body.apiType,
        );
        if (Object.keys(body.secretHeaderRefs ?? {}).length > 0) {
          if (!ctx.acpProviderSecretResolver) {
            throw new Error('ACP provider secret resolution is unavailable.');
          }
          resolution =
            await ctx.acpProviderSecretResolver.resolveForAcpProvider({
              connectionId: id,
              providerId: body.providerId,
              secretHeaderRefs: body.secretHeaderRefs ?? {},
            });
        }
        await ctx.acpBridge.setProvider(id, {
          providerId: body.providerId,
          apiType: body.apiType,
          baseUrl: body.baseUrl,
          headers: resolution?.environment,
        });
        resolution?.settlement.settle({ outcome: 'success' });
        return c.json({
          success: true,
          data: {
            providerId: body.providerId,
            apiType: body.apiType,
            baseUrl: body.baseUrl,
          },
        });
      } catch (error) {
        resolution?.settlement.settle({
          outcome: 'failure',
          reason: 'child_establishment_failed',
        });
        if (error instanceof SecretBindingResolutionError) {
          return c.json(
            {
              success: false,
              error: 'The ACP provider secret binding cannot be established.',
            },
            400,
          );
        }
        if (error instanceof ACPProviderRouteValidationError) {
          return c.json(
            { success: false, error: acpProviderRoutePublicError(error) },
            409,
          );
        }
        if (
          (error as Error | undefined)?.name ===
          'ACPProviderRoutingUnsupportedError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'This ACP agent did not advertise provider routing support.',
            },
            409,
          );
        }
        throw error;
      }
    },
  );

  app.post(
    '/connections/:id/providers/disable',
    validate(acpDisableProviderSchema),
    async (c) => {
      const id = param(c, 'id');
      const body = getBody(c);
      try {
        await ctx.acpBridge.disableProvider(id, body.providerId);
        return c.json({ success: true });
      } catch (error) {
        if (
          (error as Error | undefined)?.name ===
          'ACPRequiredProviderDisableError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'The requested ACP provider is required and cannot be disabled.',
            },
            409,
          );
        }
        if (
          (error as Error | undefined)?.name ===
          'ACPProviderRoutingUnsupportedError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'This ACP agent did not advertise provider routing support.',
            },
            409,
          );
        }
        throw error;
      }
    },
  );

  return app;
}
