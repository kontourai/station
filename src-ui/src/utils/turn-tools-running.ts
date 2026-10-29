import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';

/**
 * Whether the server's record of the open turn holds a tool call still
 * executing: the one fact the pill's "Working" and a queued steer's
 * "Waiting for tools" both read, so the two agree before and after a reload.
 */
export function turnToolsRunning(
  activity: ConversationTurnActivity | undefined,
): boolean {
  return Boolean(
    activity?.openTurn && (activity.runningTools?.length ?? 0) > 0,
  );
}
