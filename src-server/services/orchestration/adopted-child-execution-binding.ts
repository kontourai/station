import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { EngineId } from '@kontourai/station-contracts/provider';
import {
  type EngineAgentCatalog,
  findEngineAgent,
} from '../../domain/agent-registry.js';

/**
 * #3429: the Agent and Environment a continued attached conversation runs
 * as. A chat started from the dock records these on its start
 * (`execution-target-execution.ts`); without them the dock cannot open the
 * continuation and a `/chat` follow-up has no verified execution binding.
 */
export interface AdoptedChildExecutionBinding {
  /** The engine's own Agent, as New Chat's Enable selects it. */
  readonly agentId: string;
  /** The engine connection that Agent is bound to. */
  readonly connectionId: string;
  /** This Station's Environment, the one `/chat` resolves as `current`. */
  readonly environmentId: string;
}

/**
 * Undefined when the engine has no Agent on this Station: the continuation
 * is still created (Activity sends its turns directly), and the dock says why
 * it cannot open it. Nothing here creates an Agent.
 */
export type ResolveAdoptedChildExecutionBinding = (
  provider: EngineId,
) => Promise<AdoptedChildExecutionBinding | undefined>;

export function createAdoptedChildExecutionBindingResolver(deps: {
  configLoader: EngineAgentCatalog;
  /** Read per adoption: an Environment reset changes the identity. */
  readEnvironmentId: () => Promise<string>;
}): ResolveAdoptedChildExecutionBinding {
  return async (provider) => {
    const agentId = await findEngineAgent(
      deps.configLoader,
      provider,
      engineDisplayLabel(provider) ?? provider,
    );
    if (!agentId) return undefined;
    return {
      agentId,
      connectionId: engineConnectionId(provider),
      environmentId: await deps.readEnvironmentId(),
    };
  };
}

/**
 * The binding fields of a dock-started chat's start metadata, for an adopted
 * child. `conversationId` is the child itself: it is the root of its own
 * Station conversation, exactly as a fresh chat's first Session is.
 */
export function adoptedChildExecutionBindingMetadata(
  binding: AdoptedChildExecutionBinding | undefined,
  childThreadId: string,
): Record<string, string> {
  if (!binding) return {};
  return {
    agentId: binding.agentId,
    agentSlug: binding.agentId,
    targetKind: 'agent',
    targetId: binding.agentId,
    connectionId: binding.connectionId,
    environmentId: binding.environmentId,
    conversationId: childThreadId,
  };
}
