import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  activityChatTarget,
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

describe('origin and chat target', () => {
  test('an attached transcript is started in its engine; an unrecorded one is said so', () => {
    const attached = summary({ controlMode: 'read-only-attached' });
    expect(activityOriginKey(attached)).toBe('Started in Claude Code');
    expect(activityOriginShortLabel(attached)).toBe('Claude Code');
    expect(activityOriginKey(summary())).toBe('Origin not recorded');
    expect(activityOriginShortLabel(summary())).toBeNull();
  });

  test('Open in chat uses the conversation id and the local project page', () => {
    expect(
      activityChatTarget(
        summary({ conversationId: 'conv-1', projectSlug: 'station' }),
      ),
    ).toEqual({
      pathname: '/projects/station',
      params: { chat: 'conv-1', dock: 'open' },
    });
    expect(activityChatTarget(summary())).toEqual({
      pathname: '/',
      params: { chat: 'thread-1', dock: 'open' },
    });
  });
});
