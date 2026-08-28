/**
 * Shared relative-time util extracted from ChatDockInboxPanel so every
 * work-item surface (Home lanes, inbox, mobile task switcher) renders the
 * same "2m ago" story. Owner report : task rows showed no time
 * anywhere.
 */

import { describe, expect, it } from 'vitest';
import { relativeTime, relativeTimeAgo } from '../utils/relativeTime';

const NOW = 1_755_000_000_000;

describe('relativeTime', () => {
  it('formats compact durations', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('now');
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe('2m');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d');
  });

  it('station#1795 guard: an absent stamp never reads as a multi-year duration', () => {
    expect(relativeTime(0, NOW)).toBe('now');
    expect(relativeTime(-5, NOW)).toBe('now');
    expect(relativeTime(Number.NaN, NOW)).toBe('now');
  });

  it('sentence form for row subtitles', () => {
    expect(relativeTimeAgo(NOW - 2 * 60_000, NOW)).toBe('2m ago');
    expect(relativeTimeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTimeAgo(0, NOW)).toBe('just now');
  });
});
