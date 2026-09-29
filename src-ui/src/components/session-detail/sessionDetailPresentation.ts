import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  focusChatEventDetailForAction,
  resolveConversationOpenAction,
} from '../../views/home/work-item-open-policy';

/**
 * Who the assistant rows and the reply placeholder name: the Station agent's
 * own name when the catalog knows the slug, else the engine's product name,
 * else a neutral word. Never a raw slug or thread id.
 */
export function sessionAgentLabel(
  session: OrchestrationSessionSummary,
  agents: ReadonlyArray<{ slug: string; name?: string }>,
): string {
  const slug = session.assignedAgentSlug ?? session.delegation?.targetId;
  const agent = slug
    ? agents.find((candidate) => candidate.slug === slug)
    : undefined;
  if (agent?.name?.trim()) return agent.name.trim();
  return engineDisplayLabel(session.provider) ?? 'the agent';
}

/**
 * archive#1297's shared open policy, for the one session this page holds: a
 * Station-owned session whose agent the chat can rehydrate opens as that real
 * conversation. Anything else (no agent to rehydrate with, a read-only
 * attached transcript) has no chat to open, and the page offers none rather
 * than landing in this same inspector again.
 */
export function sessionChatOpenTarget(session: OrchestrationSessionSummary) {
  const action = resolveConversationOpenAction({
    threadId: session.threadId,
    conversationId: session.conversationId,
    agentSlug: session.assignedAgentSlug,
    controlMode: session.controlMode,
    projectSlug: session.projectSlug,
    model: session.model,
  });
  return action.kind === 'rehydrate'
    ? focusChatEventDetailForAction(action)
    : null;
}

/**
 * A delegated task placed on a PAIRED Station. This Station keeps a lifecycle
 * record of it, but the transcript, the agent and the conversation live on the
 * peer — the record's agent slug and conversation id are the peer's own.
 */
export function isPeerDelegationRecord(
  session: Pick<OrchestrationSessionSummary, 'delegation'>,
): boolean {
  return session.delegation?.environmentKind === 'peer';
}

/** Same sentence the delegated-work coordinator shows for a peer record. */
export const PEER_TRANSCRIPT_ELSEWHERE =
  "Station tracks this peer task's lifecycle here. Its transcript and final answer remain on the paired Station.";
