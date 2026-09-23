import type { ChatMessage } from '../types';

/**
 * #2304: when this client sent the prompt of the turn the streaming row
 * stands for — set only when that row IS the sender's pending send: the
 * newest user message is this composer's own optimistic row (not a prompt
 * restored from another client's `turn.started`) and either it has not been
 * matched to a turn yet while the send is in flight, or it carries the open
 * turn's id. After a reconnect catch-up (`openTurnShellSuperseded`) the turn
 * may have changed in the gap, so no send time is claimed.
 */
export function senderSentAt(session: {
  messages?: readonly ChatMessage[];
  status?: string;
  openTurnId?: string;
  openTurnShellSuperseded?: boolean;
}): number | undefined {
  if (session.openTurnShellSuperseded) return undefined;
  const prompt = [...(session.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  if (
    !prompt?.clientId ||
    prompt.clientId.startsWith('event-input:') ||
    prompt.timestamp === undefined
  ) {
    return undefined;
  }
  if (prompt.turnId) {
    return prompt.turnId === session.openTurnId ? prompt.timestamp : undefined;
  }
  return session.status === 'sending' ? prompt.timestamp : undefined;
}
