import type { OutboundStationIdentity } from './outboundQueue';

/**
 * The stream snapshot's hand-off to the outbox: which turn, if any, the
 * server reports open for each conversation it named (see
 * `completeAcceptedTurnsNotOpen`).
 *
 * The snapshot path publishes here instead of loading the outbox module
 * itself. Applying a snapshot stays synchronous and starts no module load of
 * its own, and the outbox, loaded by its own mount, takes what was observed
 * before it arrived.
 */
export interface ConversationOpenTurnObservation {
  records: readonly { conversationId: string; openTurnId?: string }[];
  /** When this renderer read the records. */
  observedAt: number;
  station?: OutboundStationIdentity;
}

type AcceptedTurnSettler = (
  observation: ConversationOpenTurnObservation,
) => void;

/**
 * Observations kept for an outbox that has not loaded yet. Past this many the
 * oldest goes: its rows wait for the next snapshot, as they did before any
 * snapshot named them.
 */
const MAX_WAITING_OBSERVATIONS = 16;

let settler: AcceptedTurnSettler | undefined;
const waiting: ConversationOpenTurnObservation[] = [];

export function observeConversationOpenTurns(
  observation: ConversationOpenTurnObservation,
): void {
  if (observation.records.length === 0) return;
  if (settler) {
    settler(observation);
    return;
  }
  waiting.push(observation);
  if (waiting.length > MAX_WAITING_OBSERVATIONS) waiting.shift();
}

/** The outbox registers once, as it loads, and receives what waited for it. */
export function registerAcceptedTurnSettler(next: AcceptedTurnSettler): void {
  settler = next;
  for (const observation of waiting.splice(0)) next(observation);
}
