// @vitest-environment jsdom

import { ATTENTION_SNOOZE_MAX_MS } from '@kontourai/station-contracts/attention';
import { describe, expect, test } from 'vitest';
import { clockTime } from '../../../utils/relativeTime';
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
  test('is the one list, in order, each with the real time it ends', () => {
    const choices = snoozeChoices(wednesdayMorning.getTime());
    expect(choices.map((choice) => choice.label)).toEqual([
      'In 1 hour',
      'This evening',
      'Tomorrow morning',
      'Next week',
    ]);
    expect(choices[0].wakeAt - wednesdayMorning.getTime()).toBe(3_600_000);
    const morning = wednesdayMorning.getTime();
    // Today's choices read as a clock time; another day's lead with it.
    expect(choices[1].hint).toBe(
      clockTime(new Date(2026, 9, 28, 18).getTime(), morning),
    );
    expect(choices[1].hint).not.toMatch(/^[A-Z][a-z]{2} /);
    expect(choices[2].hint).toBe(
      clockTime(new Date(2026, 9, 29, 9).getTime(), morning),
    );
    expect(choices[2].hint).toMatch(/^Thu /);
  });
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
