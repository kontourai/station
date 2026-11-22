import {
  CONVERSATION_FORK_REFUSAL_CODES,
  CONVERSATION_HANDOFF_PREDECESSOR_BUSY_CODE,
} from '@kontourai/station-contracts/orchestration';
import { userFacingErrorMessage } from '../../utils/errorText';

/**
 * What to tell the person when Station refuses to carry a conversation to an
 * Agent: Fork from here and Continue with another agent share these words.
 * Keyed by the refusal's machine code, never its server text; any other
 * failure reads as `userFacingErrorMessage` says.
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  [CONVERSATION_FORK_REFUSAL_CODES.historyUnavailable]:
    'Station couldn’t read this chat’s history just now. Try again.',
  [CONVERSATION_FORK_REFUSAL_CODES.historyTooLarge]:
    'The chat up to this answer is too large to fork. Fork from an earlier answer.',
  [CONVERSATION_FORK_REFUSAL_CODES.turnIncomplete]:
    'This answer didn’t finish, so it can’t be forked. Fork from a completed answer.',
  [CONVERSATION_FORK_REFUSAL_CODES.sourceAgentMismatch]:
    'Station couldn’t match this answer to the agent that wrote it. Reopen the chat and try again.',
  [CONVERSATION_FORK_REFUSAL_CODES.targetUnavailable]:
    'That agent isn’t available for this chat’s project. Choose another.',
  [CONVERSATION_FORK_REFUSAL_CODES.sourceNotFound]:
    'This chat is no longer available.',
  [CONVERSATION_FORK_REFUSAL_CODES.idempotencyConflict]:
    'This fork request is out of date. Close this and fork again.',
  [CONVERSATION_FORK_REFUSAL_CODES.callerUnresolved]:
    'Station couldn’t confirm who is asking. Reconnect, then try again.',
  [CONVERSATION_HANDOFF_PREDECESSOR_BUSY_CODE]:
    'The current agent is still working. Wait for it to finish, then try again.',
};

export function conversationRefusalMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const copy = typeof code === 'string' ? REFUSAL_COPY[code] : undefined;
  if (copy) return copy;
  return error instanceof Error ? userFacingErrorMessage(error) : String(error);
}
