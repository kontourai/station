import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { Agent } from '@voltagent/core';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { awaitSettlementWithin } from '../../utils/bounded-async.js';
import { getActiveRuntimeProjectSlug } from '../bootstrap/runtime-startup.js';
import { ManagedModelUnavailableError } from '../plugins/runtime-provider-resolution.js';
import { hasNoStationEngineInstanceToBuild } from './agent-engine-classification.js';
import type { PreparedRuntimeAgentInstance } from './runtime-agent-builder.js';

export async function reloadRuntimeAgents({
  configLoader,
  activeAgents,
  agentMetadataMap,
  agentSpecs,
  agentTools,
  memoryAdapters,
  mcpConfigs,
  preparedMcpConfigs,
  mcpConnectionStatus,
  integrationMetadata,
  voltAgent,
  logger,
  eventBus,
  prepareVoltAgentInstance,
  activateVoltAgentInstance,
  commitPreparedResources,
  cleanupPreparedResources,
  assertConfigurationCurrent = () => undefined,
  retainRetiredResource,
  releaseRetiredResource,
  retiredResourceCleanupTimeoutMs = 2_000,
  loadAppConfig,
}: {
  configLoader: ConfigLoader;
  activeAgents: Map<string, Agent>;
  agentMetadataMap: Map<string, any>;
  agentSpecs: Map<string, AgentSpec>;
  agentTools: Map<string, any[]>;
  memoryAdapters: Map<string, any>;
  mcpConfigs: Map<string, { disconnect(): Promise<void> }>;
  preparedMcpConfigs?: Map<string, { disconnect(): Promise<void> }>;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  voltAgent?: {
    registerAgent(agent: Agent): void;
    removeAgent(id: string): boolean;
  };
  logger: any;
  eventBus: {
    emit(event: ServerEventName, data?: Record<string, unknown>): void;
  };
  prepareVoltAgentInstance: (
    slug: string,
    appConfig: AppConfig,
  ) => Promise<PreparedRuntimeAgentInstance>;
  activateVoltAgentInstance: (prepared: PreparedRuntimeAgentInstance) => Agent;
  commitPreparedResources: () => void;
  cleanupPreparedResources: () => Promise<void>;
  assertConfigurationCurrent?: () => void;
  retainRetiredResource?: (
    key: string,
    config: { disconnect(): Promise<void> },
  ) => void;
  releaseRetiredResource?: (config: { disconnect(): Promise<void> }) => void;
  retiredResourceCleanupTimeoutMs?: number;
  loadAppConfig: () => Promise<AppConfig>;
  applyAppConfig?: (appConfig: AppConfig) => void;
  applyLogLevel?: (appConfig: AppConfig) => void;
}): Promise<AppConfig> {
  const appConfig = await loadAppConfig();
  const agentMetadataList = await configLoader.listAgents();

  const preparedAgents: PreparedRuntimeAgentInstance[] = [];
  try {
    for (const metadata of agentMetadataList) {
      // Mirror the cold-boot skip (`runtime-agent-registry.ts`,
      // archive#954) — an external-engine-bound agent has no Station-engine
      // model to build. Without this skip the reload path unconditionally
      // attempted `prepareVoltAgentInstance`, which threw
      // `ManagedModelUnavailableError` and marked the agent "unavailable
      // until a model is configured" even though it is fully launchable
      // through orchestration (archive#977).
      // archive#3662: and the reserved `station` record, whose one instance is
      // `bootstrapRuntimeDefaultAgent`'s under the internal `default` key.
      if (hasNoStationEngineInstanceToBuild(metadata)) {
        logger.debug?.('Skipping agent record with no instance to build', {
          agent: metadata.slug,
          agentConnectionId: metadata.execution?.agentConnectionId,
        });
        continue;
      }
      try {
        preparedAgents.push(
          await prepareVoltAgentInstance(metadata.slug, appConfig),
        );
      } catch (error) {
        if (!(error instanceof ManagedModelUnavailableError)) throw error;
        logger.info('Agent is unavailable until a model is configured', {
          agent: metadata.slug,
          reason: error.message,
        });
      }
    }
  } catch (error) {
    try {
      await cleanupPreparedResources();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Agent preparation and cleanup both failed.',
      );
    }
    throw error;
  }

  try {
    for (const prepared of preparedAgents) {
      activateVoltAgentInstance(prepared);
    }
  } catch (error) {
    try {
      await cleanupPreparedResources();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Agent activation and prepared cleanup both failed.',
      );
    }
    throw error;
  }

  const oldAgentsById = new Map(
    [...activeAgents.entries()]
      .filter(([slug]) => slug !== 'default')
      .map(([slug, agent]) => [agent.id ?? slug, agent]),
  );
  const preparedAgentIds = new Set(
    preparedAgents.map((prepared) => prepared.agent.id ?? prepared.slug),
  );
  const registeredAgentIds: string[] = [];
  const removedAgentIds: string[] = [];
  try {
    // Gate BEFORE the first registry write, not only after it (archive#3622).
    // A pass whose activation was abandoned at its deadline can wake up while
    // a successor pass is publishing; asserting only after the register/remove
    // loops meant it wrote into the shared registry and then rolled those
    // writes back over the successor's. Checking first makes a stale pass a
    // no-op that only cleans up what it prepared.
    assertConfigurationCurrent();
    for (const prepared of preparedAgents) {
      voltAgent?.registerAgent(prepared.agent);
      registeredAgentIds.push(prepared.agent.id ?? prepared.slug);
    }
    for (const agentId of oldAgentsById.keys()) {
      if (!preparedAgentIds.has(agentId) && voltAgent?.removeAgent(agentId)) {
        removedAgentIds.push(agentId);
      }
    }
    assertConfigurationCurrent();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const agentId of removedAgentIds.reverse()) {
      try {
        voltAgent?.registerAgent(oldAgentsById.get(agentId)!);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const agentId of registeredAgentIds.reverse()) {
      try {
        const oldAgent = oldAgentsById.get(agentId);
        if (oldAgent) voltAgent?.registerAgent(oldAgent);
        else voltAgent?.removeAgent(agentId);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await cleanupPreparedResources();
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Agent publication failed and rollback was incomplete.',
      );
    }
    throw error;
  }

  const defaultMcpServers = new Set(
    agentSpecs.get('default')?.tools?.mcpServers ?? [],
  );
  const retiredResources = [...mcpConfigs.entries()].filter(([key, config]) => {
    const replacement = preparedMcpConfigs?.get(key);
    if (replacement) return replacement !== config;
    return !defaultMcpServers.has(key);
  });
  for (const [key] of retiredResources) {
    mcpConfigs.delete(key);
    mcpConnectionStatus.delete(key);
    integrationMetadata.delete(key);
  }
  for (const slug of [...activeAgents.keys()]) {
    if (slug === 'default') continue;
    activeAgents.delete(slug);
    agentMetadataMap.delete(slug);
    agentSpecs.delete(slug);
    agentTools.delete(slug);
    memoryAdapters.delete(slug);
    logger.info('Agent torn down for reload', { agent: slug });
  }
  commitPreparedResources();

  for (const prepared of preparedAgents) {
    activeAgents.set(prepared.slug, prepared.agent);
    logger.info('Agent added', { agent: prepared.slug });
  }

  const defaultMeta = agentMetadataMap.get('default');
  agentMetadataMap.clear();
  for (const metadata of agentMetadataList) {
    agentMetadataMap.set(metadata.slug, metadata);
  }
  if (defaultMeta) {
    agentMetadataMap.set('default', defaultMeta);
  }

  for (const [key, config] of retiredResources) {
    try {
      const cleanup = config.disconnect();
      const settled = await awaitSettlementWithin(
        cleanup,
        retiredResourceCleanupTimeoutMs,
      );
      if (!settled) {
        retainRetiredResource?.(key, config);
        void cleanup.then(
          () => releaseRetiredResource?.(config),
          () => undefined,
        );
        logger.error('Retired MCP cleanup timed out; ownership retained', {
          mcp: key,
          timeoutMs: retiredResourceCleanupTimeoutMs,
        });
        continue;
      }
      await cleanup;
    } catch (error) {
      retainRetiredResource?.(key, config);
      logger.error('Retired MCP cleanup failed; ownership retained', {
        mcp: key,
        error,
      });
    }
  }

  logger.info('Agents reloaded', { count: agentMetadataList.length });
  try {
    eventBus.emit(SERVER_EVENTS.AGENTS_CHANGED, {
      count: agentMetadataList.length,
    });
  } catch (error) {
    logger.error('Agent reload event listener failed', { error });
  }
  return appConfig;
}

export async function reloadRuntimeSkillsAndAgents({
  skillService,
  configLoader,
  storageAdapter,
  activeAgents,
  logger,
  createVoltAgentInstance,
}: {
  skillService: {
    discoverSkills(
      projectHomeDir: string,
      activeProject?: string,
    ): Promise<void>;
  };
  configLoader: ConfigLoader;
  storageAdapter: FileStorageAdapter;
  activeAgents: Map<string, Agent>;
  logger: any;
  createVoltAgentInstance: (slug: string) => Promise<Agent>;
}): Promise<void> {
  const activeProject = getActiveRuntimeProjectSlug(storageAdapter);
  await skillService.discoverSkills(
    configLoader.getProjectHomeDir(),
    activeProject,
  );

  const agentMetadataList = await configLoader.listAgents();
  for (const metadata of agentMetadataList) {
    try {
      const agent = await createVoltAgentInstance(metadata.slug);
      activeAgents.set(metadata.slug, agent);
      logger.info('Agent rebuilt with updated skills', {
        agent: metadata.slug,
      });
    } catch (error) {
      logger.error('Failed to rebuild agent', {
        agent: metadata.slug,
        error,
      });
    }
  }
}

export async function switchRuntimeAgent({
  targetSlug,
  activeAgents,
  voltAgent,
  logger,
  createVoltAgentInstance,
}: {
  targetSlug: string;
  activeAgents: Map<string, Agent>;
  voltAgent?: { registerAgent(agent: Agent): void };
  logger: any;
  createVoltAgentInstance: (slug: string) => Promise<Agent>;
}): Promise<Agent> {
  logger.info('Switching agent', { from: 'current', to: targetSlug });

  const existingAgent = activeAgents.get(targetSlug);
  if (existingAgent) {
    logger.info('Agent already loaded', { agent: targetSlug });
    return existingAgent;
  }

  const agent = await createVoltAgentInstance(targetSlug);
  activeAgents.set(targetSlug, agent);
  voltAgent?.registerAgent(agent);
  logger.info('Agent switched successfully', { agent: targetSlug });
  return agent;
}
