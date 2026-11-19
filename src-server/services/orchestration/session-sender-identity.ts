/**
 * #3419: how a Session names itself to the Session it messages: its title,
 * Agent and engine as Station recorded them, read server-side from the
 * Session's own records so a sender can never supply them. Absent for a
 * Session Station has no record of.
 *
 * The title is the one the Session is listed under (`extractDisplayTitle`,
 * from its first prompted turn, the conversation's first for a continuation
 * child), so the recipient's header and the Activity row agree.
 */
import { boundedDisplayText } from '@kontourai/station-shared/display-text';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import type { EventStore } from './event-store.js';
import { extractDisplayTitle } from './orchestration-session-state.js';

export interface SessionSenderIdentity {
  title?: string;
  agent?: string;
  engine: string;
}

export function sessionSenderIdentity(
  store: Pick<
    EventStore,
    | 'readSessionByThread'
    | 'conversationRootFirstPromptedTurn'
    | 'firstTurnStartedWithPrompt'
    | 'sessionAgentPresentation'
  >,
  threadId: string,
): SessionSenderIdentity | undefined {
  const session = store.readSessionByThread(threadId);
  if (!session) return undefined;
  const firstTurn =
    store.conversationRootFirstPromptedTurn(threadId) ??
    store.firstTurnStartedWithPrompt(threadId);
  const title = firstTurn
    ? extractDisplayTitle([firstTurn.payload])
    : undefined;
  const agent = store.sessionAgentPresentation(threadId)?.agentDisplayName;
  return {
    ...(title ? { title } : {}),
    ...(agent ? { agent } : {}),
    engine: session.provider,
  };
}

/** The saved chat name takes precedence over its prompt-derived Session label. */
export function notificationChatTitle(
  store: EventStore | undefined,
  threadId: string,
): string | undefined {
  if (!store) return undefined;
  try {
    const conversationId =
      store.conversationForSession(threadId)?.conversationId;
    const title =
      store.conversationTitle(
        conversationId ? [conversationId, threadId] : [threadId],
      ) ?? sessionSenderIdentity(store, threadId)?.title;
    if (!title || title === threadId || title === conversationId)
      return undefined;
    return boundedDisplayText(redactSecrets(title), 120) || undefined;
  } catch {
    // The notification can still link to the chat when its title is unavailable.
    return undefined;
  }
}
