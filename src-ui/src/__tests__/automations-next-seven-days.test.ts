/**
 * "Next 7 days" on Automations: which forecast weeks it reads and which runs
 * land on which local day, with fixed clocks and zones. The forecasts come
 * from the scheduler's own `projectWeek`, so a day boundary or a daylight
 * saving change is computed exactly as the server computes it.
 */
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { describe, expect, test } from 'vitest';
import { SchedulerService } from '../../../src-server/services/scheduling/scheduler-service.js';
import {
  forecastWeekStarts,
  nextSevenDays,
} from '../views/schedule/nextSevenDays';

const DENVER = 'America/Denver';

function forecast(jobs: SchedulerJob[], zone: string, now: number) {
  return forecastWeekStarts(now, zone).map((start) =>
    SchedulerService.prototype.projectWeek(jobs, start, zone),
  );
}

function localWallClock(time: string, zone: string): string {
  return new Date(time).toLocaleTimeString('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

describe('forecastWeekStarts', () => {
  test('reads this Monday week and the next one, by the reader’s calendar', () => {
    // Sunday 8 March 2026, 11:30 PM in Denver, already Monday in UTC.
    const now = Date.parse('2026-03-09T05:30:00.000Z');
    expect(forecastWeekStarts(now, DENVER)).toEqual([
      '2026-03-02',
      '2026-03-09',
    ]);
    expect(forecastWeekStarts(now, 'UTC')).toEqual(['2026-03-09']);
  });
});

describe('nextSevenDays', () => {
  const daily = {
    name: 'digest',
    provider: 'built-in',
    prompt: 'x',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 8 * * *', timezone: DENVER },
  } as SchedulerJob;

  test('keeps 8:00 AM local on every day across the start of daylight saving', () => {
    // Friday 6 March 2026, noon in Denver. Clocks go forward on Sunday 8.
    const now = Date.parse('2026-03-06T19:00:00.000Z');
    const result = nextSevenDays({
      weeks: forecast([daily], DENVER, now),
      now,
      zone: DENVER,
    });
    if (result.kind !== 'known') throw new Error('expected a forecast');
    expect(result.days.map((day) => day.key)).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
    expect(result.days[0]!.isToday).toBe(true);
    // This morning's run is over.
    expect(result.days[0]!.runs).toEqual([]);
    const times = result.days.slice(1).map((day) => day.runs[0]!.time);
    expect(times).toEqual([
      '2026-03-07T15:00:00.000Z',
      '2026-03-08T14:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
      '2026-03-10T14:00:00.000Z',
      '2026-03-11T14:00:00.000Z',
      '2026-03-12T14:00:00.000Z',
    ]);
    for (const time of times)
      expect(localWallClock(time, DENVER)).toBe('8:00 AM');
  });

  test('puts each run on the reader’s day when the rule is written in another zone', () => {
    const tokyo = {
      ...daily,
      name: 'tokyo',
      schedule: { kind: 'cron', expr: '0 1 * * *', timezone: 'Asia/Tokyo' },
    } as SchedulerJob;
    // Monday 2 November 2026, 9:30 AM in Denver (after the autumn change).
    const now = Date.parse('2026-11-02T16:30:00.000Z');
    const result = nextSevenDays({
      weeks: forecast([tokyo], DENVER, now),
      now,
      zone: DENVER,
    });
    if (result.kind !== 'known') throw new Error('expected a forecast');
    // 1:00 AM in Tokyo is 9:00 AM the day before in Denver: today's passed
    // half an hour ago, so the first is tomorrow (Tuesday 3).
    expect(result.days[0]!.runs).toEqual([]);
    expect(result.days[1]!.runs.map((run) => run.time)).toEqual([
      '2026-11-03T16:00:00.000Z',
    ]);
    expect(localWallClock(result.days[1]!.runs[0]!.time, DENVER)).toBe(
      '9:00 AM',
    );
  });

  test('an evening run stays on the reader’s day even when it is already tomorrow in UTC', () => {
    const evening = {
      ...daily,
      name: 'evening',
      schedule: { kind: 'cron', expr: '0 20 * * *', timezone: DENVER },
    } as SchedulerJob;
    // Friday 6 March 2026, noon in Denver; 8:00 PM there is 03:00 UTC Saturday.
    const now = Date.parse('2026-03-06T19:00:00.000Z');
    const result = nextSevenDays({
      weeks: forecast([evening], DENVER, now),
      now,
      zone: DENVER,
    });
    if (result.kind !== 'known') throw new Error('expected a forecast');
    expect(result.days[0]!.runs.map((run) => run.time)).toEqual([
      '2026-03-07T03:00:00.000Z',
    ]);
    expect(result.days[6]!.runs).toHaveLength(1);
  });

  test('leaves paused automations out', () => {
    const now = Date.parse('2026-03-06T19:00:00.000Z');
    const result = nextSevenDays({
      weeks: forecast([{ ...daily, enabled: false }], DENVER, now),
      now,
      zone: DENVER,
    });
    if (result.kind !== 'known') throw new Error('expected a forecast');
    expect(result.days.flatMap((day) => day.runs)).toEqual([]);
  });

  test('a frequent job marks its days as having runs the forecast did not count', () => {
    const minutely = {
      ...daily,
      name: 'minutely',
      schedule: { kind: 'cron', expr: '* * * * *', timezone: 'UTC' },
    } as SchedulerJob;
    const now = Date.parse('2026-03-06T19:00:00.000Z');
    const result = nextSevenDays({
      weeks: forecast([minutely], 'UTC', now),
      now,
      zone: 'UTC',
    });
    if (result.kind !== 'known') throw new Error('expected a forecast');
    expect(result.days.every((day) => day.moreUncounted)).toBe(true);
  });

  test('a missing forecast is unknown, not an empty week', () => {
    const now = Date.parse('2026-03-06T19:00:00.000Z');
    expect(nextSevenDays({ weeks: [undefined], now, zone: DENVER })).toEqual({
      kind: 'unknown',
    });
    expect(nextSevenDays({ weeks: [[daily]], now, zone: DENVER })).toEqual({
      kind: 'unknown',
    });
  });
});
