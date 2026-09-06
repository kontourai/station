import { describe, expect, test, vi } from 'vitest';
import {
  browserTimeZone,
  localCronSchedule,
  WEEKDAY_MORNING_CRON,
  weekdayMorningSchedule,
} from '../components/scheduler/scheduleValue';
import {
  buildEnrichedSchedulerJobs,
  getScheduleStarterTemplates,
  getScheduleStatusLabel,
  getScheduleStatusTone,
} from '../views/schedule/utils';

describe('schedule utils', () => {
  test('buildEnrichedSchedulerJobs merges provider stats by job name', () => {
    expect(
      buildEnrichedSchedulerJobs({
        jobs: [{ id: '1', name: 'daily', enabled: true } as any],
        stats: {
          providers: {
            local: {
              jobs: [{ name: 'daily', total: 4, success_rate: 75 }],
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        name: 'daily',
        successRate: 75,
      }),
    ]);
  });

  test('getScheduleStatus helpers derive scheduler state consistently', () => {
    expect(
      getScheduleStatusTone({
        statusError: false,
        daemonOk: true,
        schedulerHealthy: false,
      }),
    ).toBe('warning');
    expect(
      getScheduleStatusLabel({
        statusError: false,
        daemonOk: true,
        schedulerHealthy: false,
      }),
    ).toBe('Degraded');
  });

  test('getScheduleStarterTemplates returns starter schedules', () => {
    const templates = getScheduleStarterTemplates();
    expect(templates).toHaveLength(4);
    expect(templates[0]).toEqual(
      expect.objectContaining({
        name: 'good-morning',
        label: 'Morning Briefing',
      }),
    );
  });
});
/**
 * #1536 L1: the presets used to shift only the HOUR into UTC. That is wrong for
 * every zone where the shift crosses midnight, and the day-of-week field was
 * never shifted with it — at UTC+10 the three weekday presets fired Tuesday
 * through SATURDAY, and "Mondays · 8:00 AM" fired on Tuesday.
 *
 * These drive the two zones that bracket the bug (+10 crosses midnight
 * backwards, −6 does not cross at all), by naming the zone explicitly rather
 * than by moving the machine: the expression must stay in LOCAL terms in both,
 * and the zone must travel with it.
 */
describe('starter schedules keep their local meaning in any zone', () => {
  const zones = ['Australia/Brisbane', 'America/Chicago'] as const;

  test.each(zones)('%s keeps the weekday rule as written', (timezone) => {
    expect(localCronSchedule('0 8 * * 1-5', timezone)).toEqual({
      kind: 'cron',
      expr: '0 8 * * 1-5',
      timezone,
    });
    expect(weekdayMorningSchedule(timezone)).toEqual({
      kind: 'cron',
      expr: WEEKDAY_MORNING_CRON,
      timezone,
    });
  });

  test('every starter states a local hour and carries a zone', () => {
    for (const template of getScheduleStarterTemplates()) {
      expect(template.schedule.kind).toBe('cron');
      if (template.schedule.kind !== 'cron') continue;
      // The hour a reader sees in `meta` is the hour in the expression. A
      // UTC-shifted preset could not satisfy this in most of the world.
      const localHour = Number(template.schedule.expr.split(' ')[1]);
      const metaHour = /(\d+):00 (AM|PM)/.exec(template.meta);
      expect(metaHour, `no hour in "${template.meta}"`).not.toBeNull();
      const expected =
        metaHour![2] === 'PM' && metaHour![1] !== '12'
          ? Number(metaHour![1]) + 12
          : Number(metaHour![1]);
      expect(localHour).toBe(expected);
      expect(template.schedule.timezone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    }
  });

  test('omits the zone rather than inventing one when the runtime names none', () => {
    // Drives the real fallback (a runtime with no ICU data) rather than passing
    // `undefined`, which the default parameter would replace with the browser's
    // zone anyway. Absent means UTC to `@kontourai/ephemeris` — blunt, but not
    // a lie.
    const resolved = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((() => {
        throw new Error('no ICU data');
      }) as unknown as typeof Intl.DateTimeFormat);
    try {
      expect(browserTimeZone()).toBeUndefined();
      expect(localCronSchedule('0 8 * * 1-5')).toEqual({
        kind: 'cron',
        expr: '0 8 * * 1-5',
      });
    } finally {
      resolved.mockRestore();
    }
  });
});
