import type { ApiRequestScope } from '@kontourai/station-sdk';

let opening: Promise<void> | null = null;

import { openConversationTimeline } from '../../hooks/orchestration/replay/controller';
import type { ChatSession } from '../../types';

export function openTimeline(
  apiBase: string,
  session: ChatSession,
  authority: (ApiRequestScope & { isCurrent: () => boolean }) | undefined,
  notify: (message: string, sessionId?: string, duration?: number) => string,
  dismiss: (id: string) => void,
) {
  if (opening) return opening;
  const toastId = notify('Loading conversation history…', undefined, 0);
  opening = Promise.resolve()
    .then(() => {
      if (
        !session.conversationId ||
        session.replay ||
        !authority ||
        authority.apiBase !== apiBase ||
        !authority.isCurrent()
      )
        throw new Error(
          'Conversation history authorization is no longer current.',
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
      });
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      notify(
        error instanceof Error
          ? error.message
          : 'Could not open conversation history.',
      );
    })
    .finally(() => {
      dismiss(toastId);
      opening = null;
    });
  return opening;
}
