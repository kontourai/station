/**
 * The one time format for the work surfaces: compact, relative, no "ago",
 * then a short date once a week has passed; the absolute instant is a
 * tooltip. Owner report 2026-08-14: task rows showed no time anywhere; the
 * 2026-10 design audit (C9) counted seven formats across the same rows.
 */

import { describe, expect, it } from 'vitest';
import {
  absoluteTime,
  relativeTime,
  relativeTimeAgo,
  relativeTimeUntil,
} from '../utils/relativeTime';

const NOW = Date.parse('2026-10-01T17:32:00.000Z');
const DAY = 86_400_000;

describe('relativeTime', () => {
  it('formats compact durations with no "ago"', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('now');
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe('2m');
    expect(relativeTime(NOW - 41 * 60_000, NOW)).toBe('41m');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe('2d');
    expect(relativeTime(NOW - 6 * DAY - 3_600_000, NOW)).toBe('6d');
  });

  it('past a week it is a short date, with the year only when it differs', () => {
    expect(relativeTime(NOW - 19 * DAY, NOW)).toBe('Sep 12');
    expect(relativeTime(Date.parse('2025-12-24T12:00:00.000Z'), NOW)).toBe(
      'Dec 24, 2025',
    );
    expect(relativeTime(NOW - 7 * DAY, NOW)).not.toMatch(/^\d+d$/);
  });

  it('station#1795 guard: an absent stamp never reads as a multi-year duration', () => {
    expect(relativeTime(0, NOW)).toBe('now');
    expect(relativeTime(-5, NOW)).toBe('now');
    expect(relativeTime(Number.NaN, NOW)).toBe('now');
  });

  it('absoluteTime is the tooltip form, and empty for no stamp', () => {
    expect(absoluteTime(NOW)).toMatch(/2026/);
    expect(absoluteTime(NOW)).toMatch(/Oct/);
    expect(absoluteTime(0)).toBe('');
    expect(absoluteTime(Number.NaN)).toBe('');
  });

  it('the sentence form is for prose only and still never says a bare date', () => {
    expect(relativeTimeAgo(NOW - 2 * 60_000, NOW)).toBe('2m ago');
    expect(relativeTimeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTimeAgo(0, NOW)).toBe('just now');
    expect(relativeTimeAgo(NOW - 19 * DAY, NOW)).toBe('on Sep 12');
  });
});

describe('relativeTimeUntil', () => {
  const MIN = 60_000;
  const HOUR = 3_600_000;

  it('reads time remaining in the same compact vocabulary, "in" before the count', () => {
    expect(relativeTimeUntil(NOW + 30_000, NOW)).toBe('now');
    expect(relativeTimeUntil(NOW + MIN, NOW)).toBe('in 1m');
    expect(relativeTimeUntil(NOW + 41 * MIN, NOW)).toBe('in 41m');
    expect(relativeTimeUntil(NOW + 59 * MIN + 59_000, NOW)).toBe('in 59m');
    expect(relativeTimeUntil(NOW + HOUR, NOW)).toBe('in 1h');
    expect(relativeTimeUntil(NOW + 23 * HOUR + 59 * MIN, NOW)).toBe('in 23h');
    expect(relativeTimeUntil(NOW + DAY, NOW)).toBe('in 1d');
    expect(relativeTimeUntil(NOW + 2 * DAY, NOW)).toBe('in 2d');
    expect(relativeTimeUntil(NOW + 7 * DAY - MIN, NOW)).toBe('in 6d');
  });

  it('a week out it is the short date, with no "in", and the year only when it differs', () => {
    expect(relativeTimeUntil(NOW + 7 * DAY, NOW)).toBe('Oct 8');
    expect(relativeTimeUntil(NOW + 19 * DAY, NOW)).toBe('Oct 20');
    expect(relativeTimeUntil(Date.parse('2027-01-05T12:00:00.000Z'), NOW)).toBe(
      'Jan 5, 2027',
    );
  });

  it('a stamp already past, or not a real time, clamps to "now"', () => {
    expect(relativeTimeUntil(NOW - 5 * MIN, NOW)).toBe('now');
    expect(relativeTimeUntil(0, NOW)).toBe('now');
    expect(relativeTimeUntil(-5, NOW)).toBe('now');
    expect(relativeTimeUntil(Number.NaN, NOW)).toBe('now');
  });
});
