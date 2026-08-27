import { describe, expect, test } from 'vitest';
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
