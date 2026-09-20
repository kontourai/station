import type { ApiRequestScope } from '@kontourai/station-sdk';
import { openConversationTimeline } from '../../hooks/orchestration/replay/controller';
import type { ChatSession } from '../../types';

export function openTimeline(
  apiBase: string,
  session: ChatSession,
  authority: (ApiRequestScope & { isCurrent: () => boolean }) | undefined,
  onError: (message: string) => void,
) {
  if (
    !session.conversationId ||
    session.replay ||
    !authority ||
    authority.apiBase !== apiBase ||
    !authority.isCurrent()
  )
    return Promise.reject(
      new Error('Conversation history authorization is no longer current.'),
    );
  return openConversationTimeline({
    apiBase,
    sourceChatId: session.id,
    sourceConversationId: session.conversationId,
    sourceThreadId: session.currentSessionId ?? session.id,
    agentSlug: session.agentSlug,
    agentName: session.agentName,
    title: session.title,
    provider: session.provider,
    projectSlug: session.projectSlug,
    projectName: session.projectName,
    requestScope: authority,
    isAuthorityCurrent: authority.isCurrent,
  })
    .then(() => undefined)
    .catch((error: unknown) =>
      onError(
        error instanceof Error
          ? error.message
          : 'Could not open conversation history.',
      ),
    );
}
