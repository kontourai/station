import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';

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
 * Session runs on the Agent's current connection. The composer chip and the
 * dock header both read this, so they cannot name different engines.
 *
 * - `no-session`: nothing has started; the configuration is what will run.
 * - `same`: the Session runs on the Agent's current connection.
 * - `moved`: the Session's connection was observed for this very Session
 *   (`agentConnectionObservedFor`) and the Agent now points elsewhere.
 * - `unknown`: the chat's connection may belong to an earlier Session (#4162),
 *   so neither "moved" nor a connection name can be claimed.
 */
export type ChatEngineRelation = 'no-session' | 'same' | 'moved' | 'unknown';

export interface ChatEngineIdentity {
  relation: ChatEngineRelation;
  /**
   * The live Session's engine, when it can be named: a native provider's
   * product name, or an ACP Session's own observed connection. Absent while
   * that is unresolved (connections still loading, an unrecognised provider,
   * or a possibly stale connection), so callers show something neutral.
   */
  sessionEngine?: string;
  /**
   * Whether the execution Agent's configuration names the engine: it
   * resolved (`chatExecutionBinding`), and either nothing has started or the
   * Session runs on its current connection. Otherwise only `sessionEngine`
   * may name it.
   */
  configurationNamesEngine: boolean;
}

/**
 * The Agent whose engine binding runs a chat: a conversation override's
 * execution Agent (`executionAgentId`), else the chat's own Agent. `null`
 * when that Agent is not in `agents` (deleted, or not loaded yet). An
 * override never borrows the chat Agent's binding, which is not what runs.
 * The composer chip and the dock header both resolve it here, so they
 * compare the Session against the same Agent.
 */
export function chatExecutionBinding<Agent extends { slug: string }>(
  chat: { agentSlug?: string; executionAgentId?: string },
  agents: readonly Agent[],
): Agent | null {
  const slug = chat.executionAgentId ?? chat.agentSlug;
  return (
    (slug ? agents.find((agent) => agent.slug === slug) : undefined) ?? null
  );
}

export function chatEngineIdentity(input: {
  /** `ChatSession.orchestrationProvider`: set only from server session facts. */
  orchestrationProvider?: EngineId;
  /** The chat's current execution Session (`currentSessionId`, else its conversation). */
  currentSessionId?: string;
  /** `ChatSession.agentConnectionId`. */
  sessionConnectionId?: string | null;
  /** `ChatSession.agentConnectionObservedFor`. */
  connectionObservedFor?: string;
  /** The execution Agent (`chatExecutionBinding`); `null` when it did not resolve. */
  binding: { execution?: { agentConnectionId?: string | null } } | null;
  acpConnections?: readonly { id: string; name: string }[];
}): ChatEngineIdentity {
  const provider = input.orchestrationProvider;
  if (!provider)
    return {
      relation: 'no-session',
      configurationNamesEngine: input.binding !== null,
    };
  const sessionConnection = input.sessionConnectionId || undefined;
  const sameConnection =
    sessionConnection ===
    (input.binding?.execution?.agentConnectionId || undefined);
  const observed =
    input.currentSessionId !== undefined &&
    input.connectionObservedFor === input.currentSessionId;
  // A successor always starts on the Agent's binding at send time, so a chat
  // connection equal to the Agent's current one describes the Session even
  // when its observation is older (wrong only if the Agent was repointed away
  // and back in between).
  const relation: ChatEngineRelation = sameConnection
    ? 'same'
    : observed
      ? 'moved'
      : 'unknown';
  // The generic ACP provider says nothing about the product; only the
  // Session's own connection names it, and only once that is known to be
  // this Session's. Every other provider names itself.
  const sessionEngine =
    provider === 'acp'
      ? relation === 'unknown'
        ? undefined
        : input.acpConnections?.find(
            (connection) => connection.id === sessionConnection,
          )?.name
      : (engineDisplayLabel(provider) ?? undefined);
  return {
    relation,
    ...(sessionEngine ? { sessionEngine } : {}),
    configurationNamesEngine: input.binding !== null && relation === 'same',
  };
}

/** Session statuses whose engine binding can take no further turn. */
const ENDED_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'exited',
  'closed',
  'dead',
  'error',
]);

/**
 * Whether the chat's next turn starts a new Session, on the Agent's current
 * engine, instead of running in the current one. A live status observed for
 * the Session answers first: its engine binding ended
 * (`exited`/`closed`/`dead`/`error`; `errored` can be a failed turn on a
 * Session that continues). With none observed, as after a fresh open, the
 * open read's `nextTurnStartsSession` answers (#4179), the server's own
 * continuation rule, and only while it describes the chat's current Session.
 */
export function chatNextTurnStartsSession(chat: {
  orchestrationStatus?: string;
  currentSessionId?: string;
  conversationId?: string;
  conversationOpenState?: ConversationOpenResolution;
}): boolean {
  if (chat.orchestrationStatus !== undefined)
    return ENDED_SESSION_STATUSES.has(chat.orchestrationStatus);
  const open = chat.conversationOpenState;
  return (
    open?.status === 'resolved' &&
    open.currentSessionId === (chat.currentSessionId ?? chat.conversationId) &&
    open.nextTurnStartsSession === true
  );
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
