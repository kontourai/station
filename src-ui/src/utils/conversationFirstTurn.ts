import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { isFirstSendFailure } from '@kontourai/station-contracts/session-attention';

/**
 * Whether the conversation on screen has never run a turn: the server calls it
 * a Draft or a first-send failure, AND nothing this client knows says a turn
 * has since started. The summary is a read that can lag in either direction:
 * the send path re-reads it after a refusal (so a refused first send unlocks
 * what depends on this without a reload), and a turn that is in flight right
 * now outranks a summary read before it began.
 */
export function conversationAwaitsFirstTurn(
  summary:
    | Pick<OrchestrationSessionSummary, 'draft' | 'terminalAttribution'>
    | null
    | undefined,
  /** `isTurnInFlight` for the chat on screen. */
  turnInFlight: boolean,
): boolean {
  if (!summary) return false;
  if (summary.draft !== true && !isFirstSendFailure(summary)) return false;
  return !turnInFlight;
}
