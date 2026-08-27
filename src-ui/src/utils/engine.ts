import type { EngineId } from '@kontourai/station-contracts/agent-identity';

/**
 * What executes an agent (docs/glossary.md — "the one question"): a display
 * name plus an optional distinguishing model. `model` is populated only for
 * ACP-connected agents (§A2 in the #894 plan) — it's the live current model,
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
    const resolvedName = agent.connectionName ?? agent.name ?? 'Custom engine';
    // acp-manager-view.ts falls back the live-model field to the
    // connection's own name/id when no current model has been reported yet
    // (`model: modelConfig?.currentValue || config?.name || id`) — that
    // fallback must never render as a self-referential "Kiro · Kiro" chip
    // (MED-1), so suppress a model that's falsy or duplicates the name we
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
      ? { name: 'Station' }
      : { name: agent.engineDisplayName };
  }

  if (agent.engineId === 'station') return { name: 'Station' };
  if (!agent.execution?.agentConnectionId) return { name: 'Station' };
  return null;
}
