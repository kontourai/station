/**
 * The per-phone FCM send floor (#2588): at most one gateway send to an
 * Android phone every three seconds, whatever it carries. The gateway allows
 * 30 sends a minute per push token, shared between the agent-activity card
 * and Station notifications, so the two senders share one floor rather than
 * each keeping its own and together exceeding it.
 *
 * In memory, per device id. A slot may be reserved in the future: a
 * notification waiting out the floor holds its slot, so a card that comes
 * next waits for the slot after it.
 *
 * The card cannot starve behind a burst of notifications: each time the
 * card is held back by a slot a notification took it says so
 * (`deferCard`), and once it has been held back {@link CARD_YIELD_AFTER}
 * times the notification channel leaves the next slot free for it
 * (`takeCardYield`). The card's own send (`recordCard`) clears the count.
 */

/** Deferrals after which notifications leave the card the next slot. */
const CARD_YIELD_AFTER = 2;

/** Never send to one phone more often than this. */
export const NATIVE_PUSH_MIN_SEND_INTERVAL_MS = 3_000;

export interface NativePushSendFloor {
  /** The last send attempt (or reserved slot) for this phone, if any. */
  lastSendAt(deviceId: string): number | undefined;
  /** Records a send attempt at `at` (a later reservation is never moved back). */
  record(deviceId: string, at: number): void;
  /**
   * Reserves the earliest slot at or after `at` that respects the floor,
   * records it, and returns it.
   */
  reserve(deviceId: string, at: number): number;
  /** The card's send: recorded like any other, and its deferrals cleared. */
  recordCard(deviceId: string, at: number): void;
  /** The card was held back by a slot a notification holds. */
  deferCard(deviceId: string): void;
  /**
   * Whether the card has waited long enough that the next slot is its own;
   * true clears the count, so a notification yields at most once for it.
   */
  takeCardYield(deviceId: string): boolean;
}

export function createNativePushSendFloor(): NativePushSendFloor {
  const last = new Map<string, number>();
  const cardDeferrals = new Map<string, number>();
  /**
   * Entries more than one interval older than `now` constrain nothing.
   * `now` is always the real current time, never a reserved future slot:
   * pruning against a slot seconds ahead would drop other phones' entries
   * that still hold them back.
   */
  const prune = (now: number) => {
    for (const [id, sentAt] of last)
      if (sentAt < now - NATIVE_PUSH_MIN_SEND_INTERVAL_MS) last.delete(id);
  };
  const set = (deviceId: string, at: number) => {
    const previous = last.get(deviceId);
    if (previous === undefined || at > previous) last.set(deviceId, at);
  };
  const record = (deviceId: string, at: number) => {
    prune(at);
    set(deviceId, at);
  };
  return {
    lastSendAt: (deviceId) => last.get(deviceId),
    record,
    recordCard(deviceId, at) {
      record(deviceId, at);
      cardDeferrals.delete(deviceId);
    },
    deferCard(deviceId) {
      cardDeferrals.set(deviceId, (cardDeferrals.get(deviceId) ?? 0) + 1);
    },
    takeCardYield(deviceId) {
      if ((cardDeferrals.get(deviceId) ?? 0) < CARD_YIELD_AFTER) return false;
      cardDeferrals.delete(deviceId);
      return true;
    },
    reserve(deviceId, at) {
      prune(at);
      const previous = last.get(deviceId);
      const slot =
        previous === undefined
          ? at
          : Math.max(at, previous + NATIVE_PUSH_MIN_SEND_INTERVAL_MS);
      set(deviceId, slot);
      return slot;
    },
  };
}
