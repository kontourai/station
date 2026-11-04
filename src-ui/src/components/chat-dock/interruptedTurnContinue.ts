import type { ChatMessage } from '../../types';

/** The Feature Preview that offers Continue after a restart cut a turn off. */
export const CONTINUE_INTERRUPTED_TURN_PREVIEW_ID = 'continue-interrupted-turn';

/**
 * The interrupted-turn boundary `row` can offer Continue for: only while that
 * interruption is still the conversation's latest state. The latest row other
 * than this window's own ephemeral notices must carry the same boundary (by
 * boundary, not by object or index: the list may reuse an earlier copy of a
 * row, or hide rows the conversation keeps), the transcript must be settled
 * and the conversation writable, and nothing may be running or waiting to
 * send.
 */
export function continuableInterruptedBoundary(
  messages: readonly Pick<
    ChatMessage,
    'interruptedTurnBoundaryId' | 'ephemeral'
  >[],
  row: Pick<ChatMessage, 'interruptedTurnBoundaryId'>,
  conversation: {
    replay?: boolean;
    /** The transcript has caught up and the conversation accepts a send. */
    current: boolean;
    turnInFlight: boolean;
    pendingSends: number;
  },
): string | undefined {
  const boundaryId = row.interruptedTurnBoundaryId;
  if (
    !boundaryId ||
    conversation.replay ||
    !conversation.current ||
    conversation.turnInFlight ||
    conversation.pendingSends > 0
  )
    return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.ephemeral) continue;
    return message?.interruptedTurnBoundaryId === boundaryId
      ? boundaryId
      : undefined;
  }
  return undefined;
}
