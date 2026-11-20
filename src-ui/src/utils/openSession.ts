import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { openChatsStore } from '../contexts/open-chats-store';
import type { useShowSurface } from '../contexts/useShowSurface';
import {
  focusChatEventDetailForAction,
  resolveConversationOpenAction,
} from '../views/home/work-item-open-policy';

/**
 * Open a session from its summary through the shared open policy: rehydrate
 * it into the chat overlay when Station can, reveal Activity when it cannot
 * (a deleted agent, a read-only attached transcript). archive#1297's one
 * rule, shared by the Project page's live work and its Task board.
 */
export function openSessionFromSummary(
  session: OrchestrationSessionSummary,
  showSurface: ReturnType<typeof useShowSurface>,
) {
  const detail = focusChatEventDetailForAction(
    resolveConversationOpenAction({
      threadId: session.threadId,
      conversationId: session.conversationId,
      agentSlug: session.assignedAgentSlug,
      controlMode: session.controlMode,
      projectSlug: session.projectSlug,
      model: session.model,
      delegationEnvironmentKind: session.delegation?.environmentKind,
    }),
  );
  if (detail) openChatsStore.focus(detail);
  else showSurface('chat', { session: session.threadId });
}
