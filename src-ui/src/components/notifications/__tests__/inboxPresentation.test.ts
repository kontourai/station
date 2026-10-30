import { describe, expect, test } from 'vitest';
import { groupByDay, inboxDayLabel } from '../inboxPresentation';

// Local-time construction, so "yesterday" is the reader's calendar day.
const now = new Date(2026, 9, 28, 0, 30);
const at = (day: number, hour: number) =>
  new Date(2026, 9, day, hour).toISOString();

describe('inboxDayLabel', () => {
  test('names today and yesterday by local calendar day, not by elapsed hours', () => {
    expect(inboxDayLabel(at(28, 0), now)).toBe('Today');
    // Three hours ago, but before midnight: yesterday.
    expect(inboxDayLabel(at(27, 21), now)).toBe('Yesterday');
  });

  test('names older days by date, and an unparseable stamp as Earlier', () => {
    expect(inboxDayLabel(at(25, 12), now)).not.toMatch(/Today|Yesterday/);
    expect(inboxDayLabel('not a date', now)).toBe('Earlier');
  });
});

describe('groupByDay', () => {
  test('groups consecutive newest-first rows into one run per day', () => {
    const rows = [at(28, 0), at(27, 22), at(27, 9), at(25, 12)];
    const groups = groupByDay(rows, (row) => row, now);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 2, 1]);
    expect(groups.slice(0, 2).map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
    ]);
  });
});
