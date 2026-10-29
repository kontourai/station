/** `/chat` facade over the orchestration SQLite turn-claim store. */

import { EventStore } from '../../services/orchestration/event-store.js';

// Re-exported from the store that enforces it, so the bound cannot drift
// between the facade and the pruner.
export { TURN_DEDUP_MAX_ENTRIES as CHAT_TURN_DEDUP_MAX_ENTRIES } from '../../services/orchestration/event-store.js';
export type ChatTurnDedupClaim =
  | { claimed: true }
  | { claimed: false; conversationId: string | null }
  /**
   * The agent may already have run this turn and its result cannot be
   * replayed: a dead owner passed its invocation point (`indeterminate`), or
   * retention evicted the resolved row (`expired`, #3559). Never run it again.
   */
  | { claimed: false; outcome: 'indeterminate' | 'expired' };

export class ChatTurnDedupStore {
  private readonly eventStore: EventStore;
  constructor(eventStore: EventStore | string, maxEntries?: number) {
    // String construction remains a test convenience only; it creates the
    // same SQLite store, never a JSON compatibility path. `maxEntries` exists
    // so a capacity test can exercise eviction against a handful of rows
    // rather than inserting 2000 — that insert cost made the eviction test
    // exceed its 5s budget under host load and fail intermittently.
    this.eventStore =
      typeof eventStore === 'string'
        ? new EventStore(eventStore, maxEntries)
        : eventStore;
  }
  claim(clientTurnId: string): ChatTurnDedupClaim {
    const claim = this.eventStore.claimChatTurn(clientTurnId);
    if (claim.claimed) return { claimed: true };
    if ('outcome' in claim) return { claimed: false, outcome: claim.outcome };
    return { claimed: false, conversationId: claim.conversationId ?? null };
  }
  /**
   * #3581: durably records that the agent may now see this turn. Call it
   * before the agent call and do not call the agent if it throws.
   */
  beginInvocation(clientTurnId: string): void {
    this.eventStore.beginChatTurnInvocation(clientTurnId);
  }
  resolve(clientTurnId: string, conversationId: string): void {
    this.eventStore.resolveChatTurn(clientTurnId, conversationId);
  }
  release(clientTurnId: string): void {
    this.eventStore.releaseChatTurn(clientTurnId);
  }
  retain(clientTurnId: string): void {
    this.eventStore.retainChatTurn(clientTurnId);
  }
  awaitResolution(
    clientTurnId: string,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<string | undefined> {
    return this.eventStore.awaitChatTurn(clientTurnId, timeoutMs, intervalMs);
  }
}
