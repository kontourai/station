/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  compileIntervalSchedule,
  compileWeeklySchedule,
  parseFriendlySchedule,
  ScheduleModeEditor,
} from '../components/scheduler/ScheduleModeEditor';

describe('ScheduleModeEditor', () => {
  test('recognizes friendly schedules and preserves arbitrary cron', () => {
    expect(parseFriendlySchedule('*/15 * * * *')).toMatchObject({
      mode: 'interval',
      intervalValue: 15,
      intervalUnit: 'minutes',
    });
    expect(parseFriendlySchedule('30 15 * * 1-5')).toMatchObject({
      mode: 'weekly',
      weeklyDays: [1, 2, 3, 4, 5],
      localTime: '15:30',
    });
    expect(parseFriendlySchedule('5 3 1 * *').mode).toBe('cron');
  });

  test('compiles intervals within cron-safe bounds', () => {
    expect(compileIntervalSchedule(20, 'minutes')).toBe('*/20 * * * *');
    expect(compileIntervalSchedule(6, 'hours')).toBe('0 */6 * * *');
    expect(compileIntervalSchedule(2, 'days')).toBe('0 0 */2 * *');
    expect(compileIntervalSchedule(60, 'minutes')).toBeNull();
  });

  test('preserves the wall-clock hour and weekday in the schedule zone', () => {
    expect(compileWeeklySchedule('20:00', [0])).toBe('0 20 * * 0');
    expect(parseFriendlySchedule('0 20 * * 0')).toMatchObject({
      mode: 'weekly',
      weeklyDays: [0],
      localTime: '20:00',
    });
  });

  test('offers accessible mode and weekday controls', () => {
    const onChange = vi.fn();
    render(
      <ScheduleModeEditor
        value="0 16 * * 1-5"
        onChange={onChange}
        timezone="UTC"
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'Weekly' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Saturday' }));
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }));
    expect(screen.getByLabelText('minute')).toBeTruthy();
  });
});
