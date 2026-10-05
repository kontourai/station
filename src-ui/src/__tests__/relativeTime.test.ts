/**
 * The one time format for the work surfaces: compact, relative, no "ago",
 * then a short date once a week has passed; the absolute instant is a
 * tooltip. Owner report 2026-08-14: task rows showed no time anywhere; the
 * 2026-10 design audit (C9) counted seven formats across the same rows.
 */

import { describe, expect, it } from 'vitest';
import {
  absoluteTime,
  clockTime,
  relativeTime,
  relativeTimeAgo,
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

describe('clockTime', () => {
  it('is the local time on the same day, and adds the weekday on another', () => {
    const today = new Date(2026, 9, 1, 23, 0).getTime();
    const tomorrow = new Date(2026, 9, 2, 6, 0).getTime();
    const morning = new Date(2026, 9, 1, 9, 0).getTime();
    const time = (at: number) =>
      new Date(at).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    expect(clockTime(today, morning)).toBe(time(today));
    const weekday = new Date(tomorrow).toLocaleDateString(undefined, {
      weekday: 'short',
    });
    expect(clockTime(tomorrow, morning)).toBe(`${weekday} ${time(tomorrow)}`);
    expect(clockTime(tomorrow, morning)).not.toBe(time(tomorrow));
  });
});
