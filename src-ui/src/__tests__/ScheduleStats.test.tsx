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

  test('a critical host is paused at capacity, matching the banner badge', () => {
    render(
      <ScheduleStats
        daemonOk
        hostPressure="critical"
        jobsCount={1}
        schedulerHealthy
        statusError={false}
        successRate={100}
        totalRuns={1}
      />,
    );

    expect(screen.getByText('Paused — host at capacity')).toBeTruthy();
    expect(screen.queryByText('● Healthy')).toBeNull();
  });

  test('a degraded host is paused BUSY, not at capacity', () => {
    // The banner says "Busy" at this posture. Saying "at capacity" here would
    // be a label nothing derived — the exact defect this card exists to avoid.
    render(
      <ScheduleStats
        daemonOk
        hostPressure="degraded"
        jobsCount={1}
        schedulerHealthy
        statusError={false}
        successRate={100}
        totalRuns={1}
      />,
    );

    expect(screen.getByText('Paused — host busy')).toBeTruthy();
    expect(screen.queryByText('Paused — host at capacity')).toBeNull();
    expect(screen.queryByText('● Healthy')).toBeNull();
  });
});
