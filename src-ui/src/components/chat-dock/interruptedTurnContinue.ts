import type { ChatMessage } from '../../types';

/** The Feature Preview that offers Continue after a restart cut a turn off. */
export const CONTINUE_INTERRUPTED_TURN_PREVIEW_ID = 'continue-interrupted-turn';

/**
 * The interrupted-turn boundary row `idx` can offer Continue for: only while
 * that interruption is still the conversation's latest state, so no row
 * other than this window's own ephemeral notices follows it, and nothing is
 * running or waiting to send.
 */
export function continuableInterruptedBoundary(
  messages: readonly Pick<
    ChatMessage,
    'interruptedTurnBoundaryId' | 'ephemeral'
  >[],
  idx: number,
  conversation: {
    replay?: boolean;
    turnInFlight: boolean;
    pendingSends: number;
  },
): string | undefined {
  const boundaryId = messages[idx]?.interruptedTurnBoundaryId;
  if (
    !boundaryId ||
    conversation.replay ||
    conversation.turnInFlight ||
    conversation.pendingSends > 0
  )
    return undefined;
  for (let later = idx + 1; later < messages.length; later++) {
    if (!messages[later]?.ephemeral) return undefined;
  }
  return boundaryId;
}
