import { describe, expect, test } from 'vitest';
import {
  buildTrendDays,
  describeDailyHistoryGap,
  periodRange,
  trendMetric,
  utcDateKey,
} from '../components/usage-stats/period';

/**
 * archive#3093: the period window must agree with how `byDate` keys are
 * written — UTC calendar dates via `toISOString.split('T')[0]` — and a
 * period of N days must cover exactly N distinct UTC dates ending today,
 * both bounds inclusive (the server filters `date >= from && date <= to`).
 */
describe('periodRange', () => {
  test('today is a single UTC date, whatever the time of day', () => {
    expect(periodRange('today', new Date('2026-08-18T00:00:00Z'))).toEqual({
      from: '2026-08-18',
      to: '2026-08-18',
    });
    expect(periodRange('today', new Date('2026-08-18T23:59:59Z'))).toEqual({
      from: '2026-08-18',
      to: '2026-08-18',
    });
  });

  test('7d covers exactly 7 distinct UTC dates ending today', () => {
    // The off-by-one trap: from = today - 6, not today - 7.
    expect(periodRange('7d', new Date('2026-08-18T12:00:00Z'))).toEqual({
      from: '2026-08-12',
      to: '2026-08-18',
    });
  });

  test('30d crosses the month boundary correctly', () => {
    expect(periodRange('30d', new Date('2026-08-18T12:00:00Z'))).toEqual({
      from: '2026-07-20',
      to: '2026-08-18',
    });
  });

  test('window edge at midnight UTC still yields N distinct dates', () => {
    expect(periodRange('7d', new Date('2026-08-01T00:00:00Z'))).toEqual({
      from: '2026-07-26',
      to: '2026-08-01',
    });
  });

  test('all time has no window — it reads the lifetime fields instead', () => {
    expect(periodRange('all', new Date('2026-08-18T12:00:00Z'))).toBeNull();
  });

  test('keys match the byDate writer shape', () => {
    // usage-aggregator-state.ts writes keys as toISOString.split('T')[0].
    expect(utcDateKey(new Date('2026-08-18T23:30:00Z'))).toBe(
      new Date('2026-08-18T23:30:00Z').toISOString().split('T')[0],
    );
  });
});

describe('buildTrendDays', () => {
  test('lays rows onto every date of the inclusive window', () => {
    const days = buildTrendDays(
      { '2026-08-12': { messages: 3, cost: 0.5 } },
      '2026-08-12',
      '2026-08-18',
    );
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe('2026-08-12');
    expect(days[6].date).toBe('2026-08-18');
  });

  test('a date with no row is unrecorded, not a measured zero', () => {
    const days = buildTrendDays(
      { '2026-08-17': { messages: 0, cost: 0 } },
      '2026-08-16',
      '2026-08-17',
    );
    // Absent row: no recorded activity — archive#3201's rule for days.
    expect(days[0]).toEqual({
      date: '2026-08-16',
      recorded: false,
      messages: 0,
      cost: 0,
    });
    // Present row with zeros: a measured zero, honestly recorded.
    expect(days[1]).toEqual({
      date: '2026-08-17',
      recorded: true,
      messages: 0,
      cost: 0,
    });
  });

  test('an inverted or malformed window yields no days', () => {
    expect(buildTrendDays({}, '2026-08-18', '2026-08-12')).toEqual([]);
    expect(buildTrendDays({}, 'not-a-date', '2026-08-18')).toEqual([]);
  });

  test('single-day window (Today) is one column', () => {
    expect(buildTrendDays(undefined, '2026-08-18', '2026-08-18')).toHaveLength(
      1,
    );
  });
});

describe('trendMetric', () => {
  test('cost when any recorded day measured one', () => {
    expect(
      trendMetric([
        { date: '2026-08-17', recorded: true, messages: 2, cost: 0 },
        { date: '2026-08-18', recorded: true, messages: 1, cost: 0.01 },
      ]),
    ).toBe('cost');
  });

  test('messages when the period recorded no cost at all', () => {
    expect(
      trendMetric([
        { date: '2026-08-17', recorded: false, messages: 0, cost: 0 },
        { date: '2026-08-18', recorded: true, messages: 4, cost: 0 },
      ]),
    ).toBe('messages');
  });
});

/**
 * archive#3266 documents that engine (orchestration) sessions contribute
 * lifetime totals but deliberately no per-day rows. The period view must say
 * so whenever such sessions exist — and must NOT gain a permanent caveat
 * when they don't.
 */
describe('describeDailyHistoryGap', () => {
  test('says nothing when daily history covers the whole corpus', () => {
    expect(describeDailyHistoryGap(undefined)).toBeNull();
    expect(
      describeDailyHistoryGap({
        sessions: 0,
        sessionsReportingTokens: 0,
        sessionsReportingCost: 0,
      }),
    ).toBeNull();
  });

  test('names the undated engine sessions when they exist', () => {
    expect(
      describeDailyHistoryGap({
        sessions: 3,
        sessionsReportingTokens: 2,
        sessionsReportingCost: 1,
      }),
    ).toBe(
      '3 engine sessions are counted in lifetime totals but not in daily history, so period figures cover Station-recorded activity only.',
    );
    expect(
      describeDailyHistoryGap({
        sessions: 1,
        sessionsReportingTokens: 1,
        sessionsReportingCost: 1,
      }),
    ).toBe(
      '1 engine session is counted in lifetime totals but not in daily history, so period figures cover Station-recorded activity only.',
    );
  });
});
