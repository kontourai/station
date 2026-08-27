/** `/chat` facade over the orchestration SQLite turn-claim store. */

import { orchestrationStorePath } from '@kontourai/station-shared/orchestration-store-quarantine';
import { EventStore } from '../../services/orchestration/event-store.js';

// Re-exported from the store that enforces it, so the bound cannot drift
// between the facade and the pruner.
export { TURN_DEDUP_MAX_ENTRIES as CHAT_TURN_DEDUP_MAX_ENTRIES } from '../../services/orchestration/event-store.js';
export type ChatTurnDedupClaim =
  | { claimed: true }
  | { claimed: false; conversationId: string | null };

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
    return claim.claimed
      ? { claimed: true }
      : { claimed: false, conversationId: claim.conversationId ?? null };
  }
  resolve(clientTurnId: string, conversationId: string): void {
    this.eventStore.resolveChatTurn(clientTurnId, conversationId);
  }
  release(clientTurnId: string): void {
    this.eventStore.releaseChatTurn(clientTurnId);
  }
  read(clientTurnId: string): string | undefined {
    return this.eventStore.readChatTurn(clientTurnId);
  }
  awaitResolution(
    clientTurnId: string,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<string | undefined> {
    return this.eventStore.awaitChatTurn(clientTurnId, timeoutMs, intervalMs);
  }
}

const instances = new Map<EventStore | string, ChatTurnDedupStore>();
export function getChatTurnDedupStore(
  eventStore: EventStore | string,
): ChatTurnDedupStore {
  let instance = instances.get(eventStore);
  if (!instance) {
    instance = new ChatTurnDedupStore(
      typeof eventStore === 'string'
        ? // Resolved, never spelled: a hand-assembled third copy of
          // `data/orchestration.sqlite` is a path the quarantine
          // (station#3217) silently stops matching.
          orchestrationStorePath(eventStore)
        : eventStore,
    );
    instances.set(eventStore, instance);
  }
  return instance;
}
export function resetChatTurnDedupStoresForTest(): void {}
