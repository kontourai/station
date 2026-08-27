import { describe, expect, test } from 'vitest';
import {
  classifyNotificationCategory,
  compareNotificationOutcome,
  DONE_TTL_MS,
  NOTIFICATION_OUTCOME_PRIORITY,
  NOTIFICATION_TTL_MS,
  outcomeFirstAllQuietHeadline,
  RUNNING_TTL_MS,
  rankNotificationContent,
  WAITING_TTL_MS,
} from '../notification-priority.js';

describe('notification-priority (station#1100 AC1 ranking)', () => {
  test('ranks needs-input > failed > running > done', () => {
    const outcomes: Array<'done' | 'running' | 'failed' | 'needs-input'> = [
      'done',
      'running',
      'failed',
      'needs-input',
    ];
    const ordered = [...outcomes].sort(
      (left, right) =>
        NOTIFICATION_OUTCOME_PRIORITY[right] -
        NOTIFICATION_OUTCOME_PRIORITY[left],
    );
    expect(ordered).toEqual(['needs-input', 'failed', 'running', 'done']);
  });

  test('compareNotificationOutcome sorts descending by importance', () => {
    expect(compareNotificationOutcome('needs-input', 'done')).toBeLessThan(0);
    expect(compareNotificationOutcome('done', 'needs-input')).toBeGreaterThan(
      0,
    );
    expect(compareNotificationOutcome('failed', 'failed')).toBe(0);
  });

  test('rankNotificationContent orders a mixed batch by outcome tier first', () => {
    const items = [
      {
        id: 'done-1',
        outcome: 'done' as const,
        updatedAt: '2026-07-28T10:00:00Z',
      },
      {
        id: 'running-1',
        outcome: 'running' as const,
        updatedAt: '2026-07-28T09:00:00Z',
      },
      {
        id: 'needs-input-1',
        outcome: 'needs-input' as const,
        updatedAt: '2026-07-28T08:00:00Z',
      },
      {
        id: 'failed-1',
        outcome: 'failed' as const,
        updatedAt: '2026-07-28T07:00:00Z',
      },
    ];
    const ranked = rankNotificationContent(items);
    expect(ranked.map((item) => item.id)).toEqual([
      'needs-input-1',
      'failed-1',
      'running-1',
      'done-1',
    ]);
  });

  test('rankNotificationContent breaks a same-tier tie by most-recently-updated', () => {
    const items = [
      {
        id: 'older',
        outcome: 'needs-input' as const,
        updatedAt: '2026-07-28T08:00:00Z',
      },
      {
        id: 'newer',
        outcome: 'needs-input' as const,
        updatedAt: '2026-07-28T09:30:00Z',
      },
    ];
    const ranked = rankNotificationContent(items);
    expect(ranked.map((item) => item.id)).toEqual(['newer', 'older']);
  });

  test('rankNotificationContent accepts numeric timestamps as well as ISO strings', () => {
    const items = [
      { id: 'a', outcome: 'running' as const, updatedAt: 1000 },
      { id: 'b', outcome: 'running' as const, updatedAt: 2000 },
    ];
    expect(rankNotificationContent(items).map((item) => item.id)).toEqual([
      'b',
      'a',
    ]);
  });

  test('rankNotificationContent does not mutate its input', () => {
    const items = [
      { id: 'a', outcome: 'done' as const, updatedAt: 1 },
      { id: 'b', outcome: 'needs-input' as const, updatedAt: 2 },
    ];
    const copy = [...items];
    rankNotificationContent(items);
    expect(items).toEqual(copy);
  });
});

describe('notification-priority (station#1100 AC2 per-state TTLs)', () => {
  test('named TTL constants match the issue-specified durations exactly', () => {
    expect(WAITING_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(RUNNING_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(DONE_TTL_MS).toBe(15 * 60 * 1000);
  });

  test('NOTIFICATION_TTL_MS wires every outcome to a TTL, failed bucketed with waiting', () => {
    expect(NOTIFICATION_TTL_MS['needs-input']).toBe(WAITING_TTL_MS);
    expect(NOTIFICATION_TTL_MS.failed).toBe(WAITING_TTL_MS);
    expect(NOTIFICATION_TTL_MS.running).toBe(RUNNING_TTL_MS);
    expect(NOTIFICATION_TTL_MS.done).toBe(DONE_TTL_MS);
  });

  test('waiting survives at least 24h, running is far shorter, done is shortest', () => {
    expect(WAITING_TTL_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(RUNNING_TTL_MS).toBeLessThan(WAITING_TTL_MS);
    expect(DONE_TTL_MS).toBeLessThan(RUNNING_TTL_MS);
  });
});

describe('notification-priority classifyNotificationCategory', () => {
  test('classifies the known pushable categories', () => {
    expect(classifyNotificationCategory('approval-request')).toBe(
      'needs-input',
    );
    expect(classifyNotificationCategory('job-failure')).toBe('failed');
    expect(classifyNotificationCategory('pairing-request')).toBe('needs-input');
    expect(classifyNotificationCategory('job-missed')).toBe('failed');
    expect(classifyNotificationCategory('scheduler-unhealthy')).toBe('failed');
  });

  test('classifies the turn-completion push categories (station#1225)', () => {
    expect(classifyNotificationCategory('turn-completed')).toBe('done');
    expect(classifyNotificationCategory('turn-stopped')).toBe('done');
    expect(classifyNotificationCategory('turn-failed')).toBe('failed');
  });

  test('returns undefined for categories outside this ranking', () => {
    expect(classifyNotificationCategory('general')).toBeUndefined();
    expect(classifyNotificationCategory('')).toBeUndefined();
  });
});

describe('notification-priority outcome-first framing (all-quiet headline)', () => {
  test('never reads as a bare zero count', () => {
    expect(outcomeFirstAllQuietHeadline('done')).not.toMatch(/0/);
    expect(outcomeFirstAllQuietHeadline('failed')).not.toMatch(/0/);
    expect(outcomeFirstAllQuietHeadline('done').toLowerCase()).not.toContain(
      'active',
    );
  });

  test('leads with the outcome', () => {
    expect(outcomeFirstAllQuietHeadline('done')).toBe('Agent work completed');
    expect(outcomeFirstAllQuietHeadline('failed')).toBe('Agent work failed');
  });
});
