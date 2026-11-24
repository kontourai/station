import type { AttentionItem } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';

/**
 * One failed run, one row. A Session that fails raises both a failed-Session
 * attention item and a stored failed-turn notification for the same thread
 * (`turn-completion-notifications.ts` writes `threadId` into its metadata).
 * Where the attention row is listed it stands for both: the notification is
 * left out of the list, and marking the row done marks the notification done
 * too, so it cannot come back as a second row.
 *
 * Answers, by attention item id, the notifications that row stands for.
 */
export function failedTurnPairs(
  items: readonly AttentionItem[],
  notifications: readonly Notification[],
): ReadonlyMap<string, readonly string[]> {
  const byThread = new Map<string, string>();
  for (const item of items)
    if (item.kind === 'session-failed')
      byThread.set(item.source.threadId, item.id);
  const pairs = new Map<string, string[]>();
  if (byThread.size === 0) return pairs;
  for (const notification of notifications) {
    if (notification.category !== 'turn-failed') continue;
    const threadId = notification.metadata?.threadId;
    const itemId =
      typeof threadId === 'string' ? byThread.get(threadId) : undefined;
    if (!itemId) continue;
    pairs.set(itemId, [...(pairs.get(itemId) ?? []), notification.id]);
  }
  return pairs;
}
