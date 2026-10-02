/**
 * THE one time format for the work surfaces (Home, the inboxes, Activity,
 * the hover card and Details sheet): relative, compact, no "ago". `now`
 * under a minute, then `2m`, `41m`, `1h`, `2d`, and a short date (`Sep 12`)
 * once a week has passed, because "9d" stops being a duration anyone reads.
 * The absolute instant belongs in a tooltip (`absoluteTime`), never in body
 * text.
 *
 * archive#1795: `updatedAt` is only ever a real epoch-ms stamp when it is
 * positive — a real `Date.now`-derived value is never 0 or negative. The
 * reported bug was exactly this guard's absence: an un-timestamped item's
 * `updatedAt` reduced to a literal 0 upstream and this function happily
 * computed "20668d" (elapsed since 1970) as if that were a real duration.
 * The upstream fix (home-view-model.ts's `latestChatTimestamp`) means a real
 * item should never reach here with `updatedAt <= 0` anymore, but this is
 * the last-resort display guard the issue asked for — no relative-time
 * string here is ever allowed to read as a plausible multi-year duration
 * derived from the absence of data.
 */
const DAY_MS = 24 * 60 * 60_000;
const SHORT_DATE_AFTER_MS = 7 * DAY_MS;

export function relativeTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 'now';
  const elapsed = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (elapsed < SHORT_DATE_AFTER_MS) return `${Math.floor(hours / 24)}d`;
  return shortDate(updatedAt, now);
}

/** "Sep 12", or "Sep 12, 2025" once the year differs from `now`'s. */
function shortDate(at: number, now: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * The absolute instant, for a `title` tooltip beside a relative time:
 * "1 Oct 2026, 17:32". Empty for a stamp that is not a real time, so a
 * caller can set no tooltip rather than one that says the epoch.
 */
export function absoluteTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "2m ago" / "just now": the sentence form, for prose that needs a clause
 * ("checked just now"). Never on a row, a card or a status line — those use
 * `relativeTime`; the vocabulary test pins that none of them says "ago".
 */
export function relativeTimeAgo(updatedAt: number, now: number): string {
  const compact = relativeTime(updatedAt, now);
  if (compact === 'now') return 'just now';
  return /^\d+[mhd]$/.test(compact) ? `${compact} ago` : `on ${compact}`;
}
