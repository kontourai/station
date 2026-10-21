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
