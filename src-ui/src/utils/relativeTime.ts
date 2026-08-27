/**
 * Compact relative-time formatting shared by the work-item surfaces (Home
 * lanes, inbox panel, mobile task switcher).
 *
 * station#1795: `updatedAt` is only ever a real epoch-ms stamp when it is
 * positive — a real `Date.now()`-derived value is never 0 or negative. The
 * reported bug was exactly this guard's absence: an un-timestamped item's
 * `updatedAt` reduced to a literal 0 upstream and this function happily
 * computed "20668d" (elapsed since 1970) as if that were a real duration.
 * The upstream fix (home-view-model.ts's `latestChatTimestamp`) means a real
 * item should never reach here with `updatedAt <= 0` anymore, but this is
 * the last-resort display guard the issue asked for — no relative-time
 * string here is ever allowed to read as a plausible multi-year duration
 * derived from the absence of data.
 */
export function relativeTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 'now';
  const elapsed = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "2m ago" / "just now" sentence form for row subtitles. */
export function relativeTimeAgo(updatedAt: number, now: number): string {
  const compact = relativeTime(updatedAt, now);
  return compact === 'now' ? 'just now' : `${compact} ago`;
}
