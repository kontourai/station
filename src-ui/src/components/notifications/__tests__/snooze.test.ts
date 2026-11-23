// @vitest-environment jsdom

import { ATTENTION_SNOOZE_MAX_MS } from '@kontourai/station-contracts/attention';
import { describe, expect, test } from 'vitest';
import { snoozeChoices, snoozePresets } from '../../inbox-row/snooze-presets';
import { formatSnoozeUntil, isDeferredNotification } from '../snooze';

// Local-time construction: presets are the reader's clock, not UTC.
const wednesdayMorning = new Date(2026, 9, 28, 10, 0);
const wednesdayNight = new Date(2026, 9, 28, 21, 0);

describe('snoozePresets', () => {
  test('every preset is a future instant the server will accept', () => {
    for (const now of [wednesdayMorning, wednesdayNight]) {
      for (const preset of snoozePresets(now)) {
        const ahead = preset.until.getTime() - now.getTime();
        expect(ahead).toBeGreaterThan(0);
        expect(ahead).toBeLessThanOrEqual(ATTENTION_SNOOZE_MAX_MS);
      }
    }
  });

  test('"This evening" is offered only while the evening is still ahead', () => {
    expect(snoozePresets(wednesdayMorning).map((p) => p.label)).toContain(
      'This evening',
    );
    expect(snoozePresets(wednesdayNight).map((p) => p.label)).not.toContain(
      'This evening',
    );
  });

  test('next week means next Monday at 9, a full week out on a Monday', () => {
    const next = snoozePresets(wednesdayMorning).find(
      (p) => p.label === 'Next week',
    )?.until;
    expect(next?.getDay()).toBe(1);
    expect(next?.getDate()).toBe(2); // Monday, Nov 2
    expect(next?.getHours()).toBe(9);
    const monday = new Date(2026, 10, 2, 8, 0);
    const fromMonday = snoozePresets(monday).find(
      (p) => p.label === 'Next week',
    )?.until;
    expect(fromMonday?.getDate()).toBe(9);
  });
});

describe('snoozeChoices', () => {
  test('is the one list, in order, each with the time it ends', () => {
    const choices = snoozeChoices(wednesdayMorning.getTime());
    expect(choices.map((choice) => choice.label)).toEqual([
      'In 1 hour',
      'This evening',
      'Tomorrow morning',
      'Next week',
    ]);
    expect(choices[0].wakeAt - wednesdayMorning.getTime()).toBe(3_600_000);
    // Today reads as a clock time, tomorrow says so, a later week a date.
    expect(choices[1].hint).toMatch(/^6:00\sPM$/);
    expect(choices[2].hint).toMatch(/^tomorrow 9:00\sAM$/);
    expect(choices[3].hint).toMatch(/^Mon 9:00\sAM$/);
    // A Monday before 9: next week is seven days out, so it reads as a date.
    const monday = snoozeChoices(new Date(2026, 10, 23, 8, 30).getTime());
    expect(monday[3].hint).toMatch(/^Nov 30 9:00\sAM$/);
  });

  test('"Tomorrow morning" is always tomorrow, even before 9 today', () => {
    const early = new Date(2026, 10, 25, 8, 30); // Wednesday 08:30
    const tomorrow = snoozeChoices(early.getTime()).find(
      (choice) => choice.label === 'Tomorrow morning',
    );
    expect(new Date(tomorrow?.wakeAt ?? 0).getDate()).toBe(26);
    expect(new Date(tomorrow?.wakeAt ?? 0).getHours()).toBe(9);
    expect(tomorrow?.hint).toMatch(/^tomorrow /);
  });

  // Every weekday at the times that move a choice (before 9, at 9, the last
  // evening minute, the first minute without one, late night), and the days
  // the clocks change in the US and in Europe.
  const DAYS = [22, 23, 24, 25, 26, 27, 28]; // Sun Nov 22 .. Sat Nov 28 2026
  const TIMES: [number, number][] = [
    [8, 30],
    [9, 0],
    [16, 59],
    [17, 0],
    [22, 48],
  ];
  const CLOCK_CHANGES = [
    new Date(2026, 2, 7, 22, 48), // Sat before the US spring change
    new Date(2026, 2, 8, 8, 30), // US spring change, a Sunday
    new Date(2026, 2, 28, 22, 48), // Sat before the EU spring change
    new Date(2026, 2, 29, 8, 30), // EU spring change, a Sunday
    new Date(2026, 9, 24, 22, 48), // Sat before the EU autumn change
    new Date(2026, 9, 25, 9, 0), // EU autumn change, a Sunday
    new Date(2026, 9, 31, 23, 30), // Sat before the US autumn change
    new Date(2026, 10, 1, 8, 30), // US autumn change, a Sunday
  ];
  const cases = [
    ...DAYS.flatMap((day) =>
      TIMES.map(([hour, minute]) => new Date(2026, 10, day, hour, minute)),
    ),
    ...CLOCK_CHANGES,
  ];

  test.each(cases.map((now) => [now.toString().slice(0, 21), now]))(
    'never offers the same instant or the same words twice (%s)',
    (_name, now) => {
      const choices = snoozeChoices(now.getTime());
      const instants = choices.map((choice) => choice.wakeAt);
      expect(new Set(instants).size).toBe(instants.length);
      const hints = choices.map((choice) => choice.hint);
      expect(new Set(hints).size).toBe(hints.length);
      // Each ends later than the one before, all in the future.
      for (const [index, instant] of instants.entries())
        expect(instant).toBeGreaterThan(index ? instants[index - 1] : +now);
      // "This evening" is offered before 5 PM and wakes at 6 PM.
      const evening = choices.find((c) => c.label === 'This evening');
      expect(Boolean(evening)).toBe(now.getHours() < 17);
      if (evening) expect(new Date(evening.wakeAt).getHours()).toBe(18);
      // The mornings wake at 9 local time, whatever the clocks did.
      for (const label of ['Tomorrow morning', 'Next week']) {
        const wake = new Date(
          choices.find((c) => c.label === label)?.wakeAt ?? 0,
        );
        expect(wake.getHours(), label).toBe(9);
        expect(wake.getMinutes(), label).toBe(0);
      }
      // Next week is a Monday at least two days out.
      const next = new Date(
        choices.find((c) => c.label === 'Next week')?.wakeAt ?? 0,
      );
      expect(next.getDay()).toBe(1);
      expect(+next - +now).toBeGreaterThan(24 * 3_600_000);
    },
  );
});

describe('formatSnoozeUntil', () => {
  test('names tomorrow and later days, not just a clock time', () => {
    expect(
      formatSnoozeUntil(
        new Date(2026, 9, 29, 9).toISOString(),
        wednesdayMorning,
      ),
    ).toMatch(/^tomorrow /);
    expect(
      formatSnoozeUntil(
        new Date(2026, 9, 28, 18).toISOString(),
        wednesdayMorning,
      ),
    ).not.toMatch(/tomorrow/);
  });
});

describe('isDeferredNotification', () => {
  const base = {
    id: 'n',
    source: 's',
    category: 'job',
    title: 't',
    priority: 'normal' as const,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
  };
  const now = Date.parse('2026-10-28T12:00:00Z');
  test('pending with a delivery time ahead is deferred; delivered or due is not', () => {
    expect(
      isDeferredNotification(
        { ...base, status: 'pending', scheduledAt: '2026-10-28T13:00:00Z' },
        now,
      ),
    ).toBe(true);
    expect(
      isDeferredNotification(
        { ...base, status: 'pending', scheduledAt: '2026-10-28T11:00:00Z' },
        now,
      ),
    ).toBe(false);
    expect(
      isDeferredNotification(
        { ...base, status: 'delivered', scheduledAt: '2026-10-28T13:00:00Z' },
        now,
      ),
    ).toBe(false);
  });
});
