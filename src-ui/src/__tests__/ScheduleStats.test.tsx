/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ScheduleStats } from '../views/schedule/ScheduleStats';

describe('ScheduleStats', () => {
  test('uses one no-data vocabulary for a zero-run success rate', () => {
    render(
      <ScheduleStats
        daemonOk
        jobsCount={1}
        schedulerHealthy
        statusError={false}
        successRate={-1}
        totalRuns={0}
      />,
    );

    expect(
      screen.getByText('Success Rate').nextElementSibling?.textContent,
    ).toBe('—');
  });

  test('host load does not replace scheduler health', () => {
    render(
      <ScheduleStats
        daemonOk
        jobsCount={1}
        schedulerHealthy
        statusError={false}
        successRate={100}
        totalRuns={1}
      />,
    );

    expect(screen.getByText('● Healthy')).toBeTruthy();
    expect(screen.queryByText(/Paused — host/u)).toBeNull();
  });
});
