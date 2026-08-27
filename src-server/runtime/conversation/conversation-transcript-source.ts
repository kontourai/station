/**
 * THE single definition of "which store serves this conversation's
 * transcript" (station#4080 slice 1, review round 2, follow-up 1).
 *
 * Two callers independently needed the exact same two-step FileMemory
 * lookup: `readConversationMessages` (`routes/chat/conversations.ts`) reads
 * it to decide whether to serve the memory store or fall through to the
 * runtime-event projection, and `InterruptedTurnRecovery.consume`
 * (`services/orchestration/orchestration-service.ts`) reads the identical
 * question to decide where the boot-time interrupted-turn banner belongs.
 * Before this extraction the second was a hand-rolled mirror of the first —
 * exactly the shape the repo's own predicate-export doctrine warns about
 * (an export that re-derives a decision is an export that eventually gets
 * it wrong): both call sites now consume this one function.
 *
 * The lookup itself: try the CONVENTIONAL `agent:<slug>` userId first (how
 * `conversation-manager.ts`'s `add-system-message` and every ordinary
 * managed-runtime turn writes), and only when that comes back empty, fall
 * back to a `getConversation` lookup for the conversation's REAL owning
 * userId (an auth alias, or a conversation created under a real
 * authenticated user rather than the synthetic agent identity). Whichever
 * comes back non-empty is both "this store is occupied for this
 * conversation" and the userId a WRITE into it must target to land in the
 * same place a later read would find it.
 *
 * Lives in `runtime/conversation/` rather than `routes/chat/` or
 * `services/orchestration/`: both of those already import from this
 * directory (`routes/chat/conversations.ts` imports `conversation-manager.ts`
 * beside this file; `orchestration-service.ts` already imports
 * `runtime/conversation/authorized-turn-correlation.js`), so this is a
 * module both layers can reach without either importing the other.
 */

export interface ConversationTranscriptSourceAdapter {
  getMessages(
    userId: string,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<unknown[]>;
  getConversation(conversationId: string): Promise<{ userId: string } | null>;
}

export interface ConversationTranscriptSource<TMessage = unknown> {
  /** Whether the store had ANY message for this conversation. */
  occupied: boolean;
  /** The userId the occupied read landed under — also the write target. */
  userId: string;
  /**
   * The messages the occupancy read actually returned, bounded by
   * `options.limit` when one was given. Non-empty iff `occupied`.
   */
  messages: TMessage[];
  /**
   * Whether `getConversation` found a record for this id, when the
   * fallback path actually ran (the conventional-userId read came back
   * empty). `undefined` when the conventional read alone already answered
   * `occupied: true` — the fallback lookup never ran, so this was never
   * determined. Callers distinguishing "no conversation at all" from "a
   * conversation with nothing said in it" need this; callers that only
   * need occupancy do not.
   */
  conversationRecordFound?: boolean;
}

export async function resolveConversationTranscriptSource<TMessage = unknown>(
  adapter: ConversationTranscriptSourceAdapter,
  conventionalUserId: string,
  conversationId: string,
  options?: { limit?: number },
): Promise<ConversationTranscriptSource<TMessage>> {
  let messages = (await adapter.getMessages(
    conventionalUserId,
    conversationId,
    options,
  )) as TMessage[];
  let userId = conventionalUserId;
  let conversationRecordFound: boolean | undefined;
  if (messages.length === 0) {
    const conversation = await adapter.getConversation(conversationId);
    conversationRecordFound = conversation !== null;
    if (conversation) {
      messages = (await adapter.getMessages(
        conversation.userId,
        conversationId,
        options,
      )) as TMessage[];
      userId = conversation.userId;
    }
  }
  return {
    occupied: messages.length > 0,
    userId,
    messages,
    ...(conversationRecordFound !== undefined
      ? { conversationRecordFound }
      : {}),
  };
}
