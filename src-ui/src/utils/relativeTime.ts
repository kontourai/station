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
import { parseEpochMs } from './parseEpochMs';

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
 * The absolute date and time (`absoluteTime`'s format) for an ISO stamp or an
 * epoch-ms value, for detail text that states when something happened.
 * `fallback` (nothing, by default) stands in for a stamp that is absent or
 * unparseable, so no surface prints "Invalid Date".
 */
export function formatDateTime(
  value: string | number | null | undefined,
  fallback = '',
): string {
  const at = typeof value === 'number' ? value : parseEpochMs(value);
  return (at === undefined ? '' : absoluteTime(at)) || fallback;
}

/**
 * A future instant as a wall-clock time, for a sentence that says when
 * something will happen ("Resets 11:00 PM"): the local time, with the short
 * weekday when it is not on `now`'s day ("Mon 11:00 PM"). Not a row time:
 * rows say how long ago with `relativeTime`.
 */
export function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * A transcript row's own clock time, for the phone answer's meta row: the
 * local time ("7:36 AM") on `now`'s day, and with the short date otherwise
 * ("Oct 3, 7:36 AM"; the year too once it differs). Unlike the work
 * surfaces' relative `relativeTime`, a transcript reads as a log, so the row
 * states when it happened. Empty for a stamp that is not a real time.
 */
export function messageTime(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${shortDate(at, now)}, ${time}`;
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

/**
 * `relativeTime` for an ISO stamp, so a surface holding a wire timestamp does
 * not write its own parse-and-bucket copy. `fallback` (nothing, by default)
 * stands in for a stamp that is absent or unparseable.
 */
export function relativeTimeFromIso(
  iso: string | null | undefined,
  now: number = Date.now(),
  fallback = '',
): string {
  const at = parseEpochMs(iso);
  return at === undefined ? fallback : relativeTime(at, now);
}

/** `relativeTimeAgo` for an ISO stamp; see `relativeTimeFromIso`. */
export function relativeTimeAgoFromIso(
  iso: string | null | undefined,
  now: number = Date.now(),
  fallback = '',
): string {
  const at = parseEpochMs(iso);
  return at === undefined ? fallback : relativeTimeAgo(at, now);
}

/**
 * The one elapsed-duration format, distinct from relative timestamps:
 * `12s` under a minute, then `4m 10s`, then `1h 4m` (`2h` on the hour). How long
 * a turn has run, how long a run has been quiet — every row, card, strip and
 * sentence that says how long something has lasted reads it here, so the
 * same item never reads "4m 10s" on one surface and "4m" on another.
 * Live clocks retain seconds under an hour.
 */
export function formatDuration(
  elapsedMs: number,
  mode: 'live' | 'coarse' = 'live',
): string {
  const seconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1000))
    : 0;
  if (mode === 'coarse') {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60)
      return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
