/**
 * The in-process half of the foreground delivery lookup
 * (`TurnDeliveryInspection`): which keyed `/chat` requests this Station is
 * handling right now. A request is recorded once the route has validated and
 * admitted it, immediately before it is executed, and forgotten when the route
 * answers — whatever the answer. Between those two points the durable turn
 * ledger may hold nothing yet (a cold session start comes before the turn
 * claim), and this record is what lets a client that lost its connection learn
 * "Station has it" instead of resending.
 *
 * Process memory on purpose: a Station that died forgets its requests with it,
 * and the ledger then answers for whatever had reached the engine.
 *
 * Keyed by the caller's identity as well as the conversation and key, so a
 * different caller asking about the same pair sees nothing.
 */

/**
 * More concurrent keyed sends than any one Station serves. Past it a new send
 * is refused rather than handled unrecorded, which would make the lookup
 * answer `not-received` for a request that is in fact in flight.
 */
const FOREGROUND_DELIVERY_RECEIPTS_MAX = 1024;

/** The refusal's fixed public text (never an internal error's message). */
export const FOREGROUND_DELIVERY_CAPACITY_MESSAGE =
  'Station is handling too many messages at once. Nothing was sent; try again shortly.';

export class ForegroundDeliveryReceiptCapacityError extends Error {
  constructor() {
    super(FOREGROUND_DELIVERY_CAPACITY_MESSAGE);
    this.name = 'ForegroundDeliveryReceiptCapacityError';
  }
}

export interface ForegroundDeliveryReceipt {
  callerKey: string;
  conversationId: string;
  clientTurnId: string;
  /** The send goes to another Station or Environment, not this one. */
  forwarded?: boolean;
}

/** Bound on remembered forwarded conversations (oldest dropped first). */
const FORWARDED_CONVERSATIONS_MAX = 4096;

export class ForegroundDeliveryReceipts {
  /** Key → number of requests carrying it (a retry can overlap the original). */
  readonly #inFlight = new Map<string, number>();
  /**
   * Conversations this process forwarded a keyed send for, per caller: their
   * turn ledger is on another Station, so nothing here proves a key unsent.
   * Process memory, bounded; the Project-default check covers a restart.
   */
  readonly #forwarded = new Set<string>();
  readonly #max: number;

  constructor(max = FOREGROUND_DELIVERY_RECEIPTS_MAX) {
    this.#max = max;
  }

  /**
   * Records one admitted request. Returns the release to call once the route
   * has answered. Throws {@link ForegroundDeliveryReceiptCapacityError} when
   * full, before anything is executed.
   */
  begin(receipt: ForegroundDeliveryReceipt): () => void {
    const key = receiptKey(receipt);
    const count = this.#inFlight.get(key) ?? 0;
    if (count === 0 && this.#inFlight.size >= this.#max)
      throw new ForegroundDeliveryReceiptCapacityError();
    this.#inFlight.set(key, count + 1);
    if (receipt.forwarded) {
      const conversation = forwardedKey(receipt);
      this.#forwarded.delete(conversation);
      this.#forwarded.add(conversation);
      if (this.#forwarded.size > FORWARDED_CONVERSATIONS_MAX) {
        const oldest = this.#forwarded.values().next().value;
        if (oldest !== undefined) this.#forwarded.delete(oldest);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) this.#inFlight.set(key, remaining);
      else this.#inFlight.delete(key);
    };
  }

  has(receipt: ForegroundDeliveryReceipt): boolean {
    return this.#inFlight.has(receiptKey(receipt));
  }

  forwarded(input: { callerKey: string; conversationId: string }): boolean {
    return this.#forwarded.has(forwardedKey(input));
  }
}

function forwardedKey(input: {
  callerKey: string;
  conversationId: string;
}): string {
  return JSON.stringify([input.callerKey, input.conversationId]);
}

function receiptKey(receipt: ForegroundDeliveryReceipt): string {
  // JSON keeps the three parts unambiguous whatever characters they hold.
  return JSON.stringify([
    receipt.callerKey,
    receipt.conversationId,
    receipt.clientTurnId,
  ]);
}
