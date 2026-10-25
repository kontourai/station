import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';

/**
 * What executes an agent (docs/glossary.md — "the one question"): a display
 * name plus an optional distinguishing model. `model` is populated only for
 * ACP-connected agents (§A2 in the archive#894 plan) — it's the live current model,
 * and precisely the fact that disambiguates two identically-named engine
 * connections (e.g. two "OpenCode" entries, one native, one ACP-connected on
 * a different model). Native rows already surface their model in the
 * picker's own model-trigger button, so repeating it in the chip would just
 * duplicate that.
 */
export interface EngineDescriptor {
  name: string; // 'Station' | connection display name
  model?: string; // distinguishing model — ACP-connected only
}

/**
 * Which engine a chat names: the one its Session runs on, or the one its Agent
 * is configured for. Repointing an Agent does not move an open Session (the
 * server's `resolveConversationContinuation` keeps the next turn on it; only a
 * successor Session starts on the Agent's current engine), so the Agent's
 * configuration describes the chat only before a Session exists, or while the
 * Agent is still bound to the Session's own connection. The composer chip and
 * the dock header both read this, so they cannot name different engines.
 */
export interface ChatEngineIdentity {
  /** The live Session's engine, once the server has reported one. */
  sessionEngine?: string;
  /** The Agent's configured engine describes this chat's Session too. */
  configurationDescribesSession: boolean;
}

export function chatEngineIdentity(input: {
  /** `ChatSession.orchestrationProvider`: set only from server session facts. */
  orchestrationProvider?: EngineId;
  /** The connection the Session was observed on (`ChatSession.agentConnectionId`). */
  sessionConnectionId?: string | null;
  /** The Agent's configured connection (`execution.agentConnectionId`). */
  configuredConnectionId?: string | null;
  acpConnections?: readonly { id: string; name: string }[];
}): ChatEngineIdentity {
  const provider = input.orchestrationProvider;
  if (!provider) return { configurationDescribesSession: true };
  // The generic ACP provider says nothing about the product; only the
  // Session's own connection names it. Every other provider names itself.
  const sessionEngine =
    (provider === 'acp'
      ? input.acpConnections?.find(
          (connection) => connection.id === input.sessionConnectionId,
        )?.name
      : undefined) ??
    engineDisplayLabel(provider) ??
    provider;
  return {
    sessionEngine,
    configurationDescribesSession:
      (input.configuredConnectionId || undefined) ===
      (input.sessionConnectionId || undefined),
  };
}

/**
 * Derives an engine chip only from fields resolved on the persisted Agent
 * payload. Agent ids are opaque; their shape never participates in routing or
 * attribution.
 */
export function agentEngineDescriptor(agent: {
  slug: string;
  name?: string;
  source?: string | null;
  engineId?: EngineId;
  engineConnectionType?: string | null;
  connectionName?: string | null;
  engineDisplayName?: string | null;
  model?: string;
  execution?: { agentConnectionId?: string | null };
}): EngineDescriptor | null {
  if (agent.engineConnectionType === 'acp') {
    const resolvedName =
      agent.connectionName ?? agent.name ?? engineDisplayLabel('acp') ?? 'acp';
    // acp-manager-view.ts falls back the live-model field to the
    // connection's own name/id when no current model has been reported yet
    // (`model: modelConfig?.currentValue || config?.name || id`) — that
    // fallback must never render as a self-referential "Kiro · Kiro" chip
    //so suppress a model that's falsy or duplicates the name we
    // just resolved or the raw connection id.
    const connectionId = agent.execution?.agentConnectionId;
    const isRedundantModel =
      !agent.model ||
      agent.model.toLowerCase() === resolvedName.toLowerCase() ||
      (!!connectionId &&
        agent.model.toLowerCase() === connectionId.toLowerCase());
    return {
      name: resolvedName,
      model: isRedundantModel ? undefined : agent.model,
    };
  }

  if (agent.engineDisplayName) {
    return agent.engineId === 'station'
      ? { name: engineDisplayLabel(agent.engineId) ?? agent.engineId }
      : { name: agent.engineDisplayName };
  }

  if (agent.engineId === 'station') {
    return { name: engineDisplayLabel(agent.engineId) ?? agent.engineId };
  }
  if (!agent.execution?.agentConnectionId) {
    return { name: engineDisplayLabel('station') ?? 'station' };
  }
  return null;
}
