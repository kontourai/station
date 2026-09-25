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
 */

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
}

export function createNativePushSendFloor(): NativePushSendFloor {
  const last = new Map<string, number>();
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
  return {
    lastSendAt: (deviceId) => last.get(deviceId),
    record(deviceId, at) {
      prune(at);
      set(deviceId, at);
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
