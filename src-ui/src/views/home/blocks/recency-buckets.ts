/**
 * Groups work into named recency buckets. A BLOCK — see `activity-bars.tsx`
 * for why these do not live inside the surface that renders them.
 */
import type { HomeWorkItem } from '../home-view-model';

const DAY_MS = 24 * 60 * 60 * 1000;

interface StreamBucket<T extends HomeWorkItem = HomeWorkItem> {
  label: string;
  items: T[];
}

/**
 * Lanes answer "what is running"; recency answers "what have I been doing",
 * which is the question you actually have after a day away. Home's list is
 * lane-organised at the top, where state is what matters, and recency-bucketed
 * in its Earlier tail, where it no longer is.
 */
export function bucketByRecency<T extends HomeWorkItem>(
  items: T[],
  now: number,
): StreamBucket<T>[] {
  // Generic so a caller passing lane items (which carry the derived
  // `stableId`) gets them back intact — Home's rows key on that identity,
  // and narrowing to HomeWorkItem here forced the caller to fabricate one.
  const buckets: StreamBucket<T>[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'This week', items: [] },
    { label: 'Older', items: [] },
  ];
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const age = startOfToday - item.updatedAt;
    if (item.updatedAt >= startOfToday) buckets[0].items.push(item);
    else if (age < DAY_MS) buckets[1].items.push(item);
    else if (age < 6 * DAY_MS) buckets[2].items.push(item);
    else buckets[3].items.push(item);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}
