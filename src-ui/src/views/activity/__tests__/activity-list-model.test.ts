import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  activityOriginKey,
  activityOriginShortLabel,
  activityRunningDetail,
  datedStreamBucket,
} from '../activity-list-model';

// A fixed local-time "now" (15:00) so calendar-day buckets are deterministic.
const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function summary(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'thread-1',
    status: 'idle',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as OrchestrationSessionSummary;
}

describe('datedStreamBucket', () => {
  test('splits by local calendar day, and never calls an unstamped session recent', () => {
    expect(datedStreamBucket(NOW - 14 * HOUR, NOW)).toBe('Earlier today');
    expect(datedStreamBucket(NOW - 16 * HOUR, NOW)).toBe('Yesterday');
    expect(datedStreamBucket(NOW - 3 * 24 * HOUR, NOW)).toBe('This week');
    expect(datedStreamBucket(NOW - 8 * 24 * HOUR, NOW)).toBe('Older');
    expect(datedStreamBucket(0, NOW)).toBe('Older');
    expect(datedStreamBucket(Number.NaN, NOW)).toBe('Older');
  });

  test('yesterday is ONE calendar day: the day before yesterday is This week', () => {
    const at = (day: number, hour: number, minute = 0) =>
      new Date(2026, 8, day, hour, minute).getTime();
    expect(datedStreamBucket(at(28, 0, 0), NOW)).toBe('Yesterday');
    expect(datedStreamBucket(at(27, 23, 59), NOW)).toBe('This week');
    expect(datedStreamBucket(at(23, 0, 0), NOW)).toBe('This week');
    expect(datedStreamBucket(at(22, 23, 59), NOW)).toBe('Older');
  });

  test('a future stamp (clock skew) reads as today, never as older', () => {
    expect(datedStreamBucket(NOW + 5 * HOUR, NOW)).toBe('Earlier today');
  });

  describe('across daylight-saving changes (America/Denver)', () => {
    const previousTz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'America/Denver';
    });
    afterAll(() => {
      process.env.TZ = previousTz;
    });

    test('the 25-hour fall-back day is still all "Yesterday"', () => {
      // 2026-11-01 is 25 hours long in Denver; midnight minus a fixed 24h
      // lands at 01:00 and misfiles its first hour as "This week".
      const now = new Date(2026, 10, 2, 10, 0).getTime();
      expect(new Date(2026, 10, 1, 0, 30).getTimezoneOffset()).not.toBe(
        new Date(2026, 10, 2, 0, 30).getTimezoneOffset(),
      );
      expect(
        datedStreamBucket(new Date(2026, 10, 1, 0, 30).getTime(), now),
      ).toBe('Yesterday');
    });

    test('the 23-hour spring-forward day does not swallow the day before it', () => {
      // 2026-03-08 is 23 hours long; midnight minus a fixed 24h lands at
      // 23:00 on 03-07 and misfiles that last hour as "Yesterday".
      const now = new Date(2026, 2, 9, 10, 0).getTime();
      expect(
        datedStreamBucket(new Date(2026, 2, 7, 23, 30).getTime(), now),
      ).toBe('This week');
      expect(
        datedStreamBucket(new Date(2026, 2, 8, 0, 30).getTime(), now),
      ).toBe('Yesterday');
    });
  });
});

describe('activityRunningDetail', () => {
  const running = (minutesAgo: number, tools?: string[]) =>
    summary({
      hasActiveTurn: true,
      conversationActivity: {
        conversationId: 'c',
        asOfSequence: 1,
        openTurn: {
          turnId: 't',
          threadId: 'thread-1',
          startedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
        },
        ...(tools
          ? {
              runningTools: tools.map((name, index) => ({
                name,
                callId: `call-${index}`,
                startedAt: new Date(NOW).toISOString(),
              })),
            }
          : {}),
      },
    });

  test('names the duration and the newest running tool', () => {
    expect(activityRunningDetail(running(3, ['Read', 'Bash']), NOW)).toEqual({
      duration: '3m',
      activity: 'using Bash',
    });
  });

  test('a fresh turn with nothing in flight adds nothing', () => {
    expect(activityRunningDetail(running(0), NOW)).toEqual({
      duration: null,
      activity: null,
    });
  });

  test('a summary with no active turn claims no running detail', () => {
    expect(
      activityRunningDetail(
        { ...running(3, ['Bash']), hasActiveTurn: false },
        NOW,
      ),
    ).toEqual({ duration: null, activity: null });
  });
});

describe('origin', () => {
  test('an attached transcript is started in its engine; an unrecorded one is said so', () => {
    const attached = summary({ controlMode: 'read-only-attached' });
    expect(activityOriginKey(attached)).toBe('Started in Claude Code');
    expect(activityOriginShortLabel(attached)).toBe('Claude Code');
    expect(activityOriginKey(summary())).toBe('Origin not recorded');
    expect(activityOriginShortLabel(summary())).toBeNull();
  });
});
