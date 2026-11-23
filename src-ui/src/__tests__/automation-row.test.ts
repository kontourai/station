/**
 * @vitest-environment jsdom
 *
 * What one Automations row says, derived from the list read: the schedule as
 * a sentence, the next run, the status word, the flag and the outcome strip's
 * name.
 */
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { describe, expect, test } from 'vitest';
import {
  automationFlag,
  automationStatus,
  nextRunText,
  outcomesSummary,
  scheduleSentence,
} from '../views/schedule/automationRow';

const job = (overrides: Partial<SchedulerJob>): SchedulerJob => ({
  name: 'digest',
  provider: 'built-in',
  prompt: 'x',
  enabled: true,
  ...overrides,
});

describe('scheduleSentence', () => {
  test.each([
    ['0 8 * * 1-5', 'Weekdays at 8:00 AM'],
    ['0 16 * * 1-5', 'Weekdays at 4:00 PM'],
    ['0 9 * * 1', 'Mondays at 9:00 AM'],
    ['0 14 * * 5', 'Fridays at 2:00 PM'],
    ['0 2 * * *', 'Every day at 2:00 AM'],
    ['30 10 * * 0,6', 'Weekends at 10:30 AM'],
  ])('%s reads "%s" in the reader’s own zone', (expr, sentence) => {
    expect(
      scheduleSentence(
        { kind: 'cron', expr, timezone: 'America/Denver' },
        'America/Denver',
      ),
    ).toBe(sentence);
  });

  test('names the rule’s zone when it is not the reader’s', () => {
    expect(
      scheduleSentence(
        { kind: 'cron', expr: '0 8 * * 1-5', timezone: 'America/Denver' },
        'Europe/London',
      ),
    ).toBe('Weekdays at 8:00 AM, Denver time');
    expect(
      scheduleSentence({ kind: 'cron', expr: '0 8 * * 1-5' }, 'Europe/London'),
    ).toBe('Weekdays at 8:00 AM, UTC');
  });

  test('intervals and rules it cannot say plainly fall back honestly', () => {
    expect(
      scheduleSentence({ kind: 'every', everyMs: 2 * 3_600_000 }, 'UTC'),
    ).toBe('Every 2 hours');
    expect(
      scheduleSentence(
        { kind: 'cron', expr: '*/15 * * * *', timezone: 'UTC' },
        'UTC',
      ),
    ).toBe('Every 15 minutes');
  });
});

describe('nextRunText', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  test('a paused automation will not run', () => {
    expect(
      nextRunText(
        job({ enabled: false, nextRun: '2026-11-23T08:00:00.000Z' }),
        now,
      ),
    ).toBe("Won't run while paused");
  });
  test('an active one says when, and says unknown when the read has no next run', () => {
    expect(
      nextRunText(job({ nextRun: '2026-11-23T08:00:00.000Z' }), now),
    ).toMatch(/^Next: Mon/);
    expect(nextRunText(job({}), now)).toBe('Next run unknown');
    expect(
      nextRunText(job({ schedule: { kind: 'at', timeMs: now - 1000 } }), now),
    ).toBe('No more runs');
  });
});

describe('status and flag', () => {
  test('status is Active, Paused or Running, in words', () => {
    expect(automationStatus(job({}), false)).toBe('Active');
    expect(automationStatus(job({ enabled: false }), false)).toBe('Paused');
    expect(automationStatus(job({}), true)).toBe('Running');
  });

  test('failures in a row are a flag; Station pausing itself replaces it', () => {
    expect(automationFlag(job({}))).toBeNull();
    expect(automationFlag(job({ consecutiveFailures: 1 }))).toBe(
      'Last run failed',
    );
    expect(automationFlag(job({ consecutiveFailures: 2 }))).toBe(
      'Last 2 runs failed',
    );
    expect(
      automationFlag(
        job({
          enabled: false,
          consecutiveFailures: 5,
          pausedItself: { failures: 5, at: '2026-11-21T02:00:00.000Z' },
        }),
      ),
    ).toBe('Paused itself after 5 failed runs');
  });
});

describe('outcomesSummary', () => {
  test('counts what the strip shows and says whether older runs exist', () => {
    expect(
      outcomesSummary(
        job({
          recentOutcomes: {
            outcomes: ['worked', 'failed', 'worked'],
            more: false,
          },
        }),
      ),
    ).toBe('All 3 runs: 2 worked, 1 failed');
    expect(
      outcomesSummary(
        job({
          recentOutcomes: { outcomes: Array(12).fill('worked'), more: true },
        }),
      ),
    ).toBe('Last 12 runs: 12 worked');
    expect(
      outcomesSummary(
        job({ recentOutcomes: { outcomes: ['skipped'], more: false } }),
      ),
    ).toBe('One run: 1 skipped');
  });
  test('absent outcomes are unknown and an empty list is no runs', () => {
    expect(outcomesSummary(job({}))).toBe('Recent runs unknown');
    expect(
      outcomesSummary(job({ recentOutcomes: { outcomes: [], more: false } })),
    ).toBe('No runs yet');
  });
});
