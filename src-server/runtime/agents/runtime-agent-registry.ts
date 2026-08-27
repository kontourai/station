import type { Agent } from '@voltagent/core';
import { hasNoStationEngineInstanceToBuild } from './agent-engine-classification.js';

interface RuntimeAgentRegistryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /**
   * Optional so existing narrow test fixtures (that never exercise the
   * external-engine skip path below) don't have to stub it. The real
   * runtime `Logger` always provides it.
   */
  debug?(message: string, meta?: Record<string, unknown>): void;
}

interface RuntimeAgentMetadata {
  slug: string;
  /**
   * Carried through from `AgentMetadata` (station#954 cold-boot fix) so
   * `isExternalEngineBoundAgent` below can classify a record without
   * loading its full spec.
   */
  execution?: { agentConnectionId?: string };
}

interface RuntimeAgentRegistryContext {
  configLoader: {
    listAgents(): Promise<RuntimeAgentMetadata[]>;
  };
  logger: RuntimeAgentRegistryLogger;
  bootstrapDefaultAgent(): Promise<Record<string, Agent>>;
  createVoltAgentInstance(slug: string): Promise<Agent>;
  activeAgents: Map<string, Agent>;
  agentMetadataMap: Map<string, RuntimeAgentMetadata | unknown>;
}

export async function initializeRuntimeAgents(
  context: RuntimeAgentRegistryContext,
): Promise<Record<string, Agent>> {
  const agentMetadataList = await context.configLoader.listAgents();
  context.logger.info('Found agents', { count: agentMetadataList.length });

  const agents = await context.bootstrapDefaultAgent();

  for (const metadata of agentMetadataList) {
    // Cleanly SKIP external-engine-bound records (station#954 cold-boot
    // fix) — a promoted default (`claude-code`, `codex`, `acp-<id>`) or any
    // user-created External agent has no Station-engine model to build;
    // attempting it anyway unconditionally threw
    // `ManagedModelUnavailableError` deep inside `createModel` and logged
    // an "error" every single boot (previously only reachable if a user
    // happened to hand-create an External agent; the promotion migration
    // made it unconditional for every connected engine). These agents are
    // still fully functional — they're served by the enriched-agents
    // synthetic/promoted-record projection and orchestration-backed chat,
    // never through this managed-runtime VoltAgent registry.
    // station#3662: also skips the reserved `station` record, whose instance
    // `bootstrapDefaultAgent` above already built under the internal
    // `default` key — see `hasNoStationEngineInstanceToBuild`.
    if (hasNoStationEngineInstanceToBuild(metadata)) {
      context.logger.debug?.(
        'Skipping agent record with no instance to build',
        {
          agent: metadata.slug,
          agentConnectionId: metadata.execution?.agentConnectionId,
        },
      );
      continue;
    }
    try {
      const agent = await context.createVoltAgentInstance(metadata.slug);
      agents[metadata.slug] = agent;
      context.activeAgents.set(metadata.slug, agent);
      context.logger.info('Agent loaded', { agent: metadata.slug });
    } catch (error) {
      context.logger.error('Failed to load agent', {
        agent: metadata.slug,
        error,
      });
    }
  }

  replaceRuntimeAgentMetadataMap(
    context.agentMetadataMap,
    agentMetadataList,
    context.logger,
  );

  return agents;
}

export function replaceRuntimeAgentMetadataMap(
  agentMetadataMap: Map<string, RuntimeAgentMetadata | unknown>,
  agentMetadataList: RuntimeAgentMetadata[],
  logger: Pick<RuntimeAgentRegistryLogger, 'info'>,
): void {
  const savedDefaultMetadata = agentMetadataMap.get('default');
  agentMetadataMap.clear();
  for (const metadata of agentMetadataList) {
    agentMetadataMap.set(metadata.slug, metadata);
  }
  if (savedDefaultMetadata) {
    agentMetadataMap.set('default', savedDefaultMetadata);
  }

  logger.info('Agent metadata map created', {
    count: agentMetadataMap.size,
    keys: Array.from(agentMetadataMap.keys()),
    sample: agentMetadataList[0]
      ? agentMetadataMap.get(agentMetadataList[0].slug)
      : undefined,
  });
}
