import { describe, expect, test } from 'vitest';
import {
  getMonitoringElapsedLabel,
  getMonitoringTimeLabel,
  getMonitoringTimeSublabel,
  toLocalDateTimeInput,
} from '../views/monitoring-time-range';

describe('monitoring-time-range', () => {
  test('toLocalDateTimeInput formats a date for datetime-local inputs', () => {
    const value = toLocalDateTimeInput(new Date('2026-01-02T03:04:05Z'));
    expect(value).toMatch(/2026-01-0[12]T/);
    expect(value).toHaveLength(16);
  });

  test('getMonitoringElapsedLabel formats short and long durations', () => {
    expect(
      getMonitoringElapsedLabel(
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-01-01T00:00:45Z'),
      ),
    ).toBe('Last 45 sec');
    expect(
      getMonitoringElapsedLabel(
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-01-01T02:00:00Z'),
      ),
    ).toBe('Last 2 hours');
  });

  test('getMonitoringTimeLabel reflects live, relative, and custom states', () => {
    expect(
      getMonitoringTimeLabel({
        clearTime: null,
        timeMode: 'relative',
        absoluteStart: '',
        isLiveMode: false,
        elapsedLabel: '',
        relativeTime: '15m',
      }),
    ).toBe('Last 15 min');

    expect(
      getMonitoringTimeLabel({
        clearTime: new Date('2026-01-01T00:00:00Z'),
        timeMode: 'absolute',
        absoluteStart: '2026-01-01T00:00',
        isLiveMode: true,
        elapsedLabel: 'Last 10 min',
        relativeTime: '5m',
      }),
    ).toBe('Last 10 min');
  });

  test('getMonitoringTimeSublabel returns relative and absolute ranges', () => {
    expect(
      getMonitoringTimeSublabel({
        clearTime: null,
        timeMode: 'relative',
        absoluteStart: '',
        absoluteEnd: '',
        isLiveMode: true,
        relativeTime: '5m',
        now: new Date('2026-01-01T12:00:00Z'),
      }),
    ).toContain('-> now');

    expect(
      getMonitoringTimeSublabel({
        clearTime: null,
        timeMode: 'absolute',
        absoluteStart: '2026-01-01T10:00',
        absoluteEnd: '2026-01-01T11:00',
        isLiveMode: false,
        relativeTime: '5m',
        now: new Date('2026-01-01T12:00:00Z'),
      }),
    ).toContain('->');
  });
});
