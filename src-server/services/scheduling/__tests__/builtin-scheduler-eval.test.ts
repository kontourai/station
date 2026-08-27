import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isOverdue,
  missedCount,
  nextOccurrences,
  type Schedule,
} from '@kontourai/ephemeris';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tempDir =
  process.env.STATION_HOME ||
  join(tmpdir(), `scheduler-eval-test-${process.pid}`);

const { createSchedulerLedger, toScheduledJob } = await import(
  '../scheduler-ledger.js'
);
let ledger: ReturnType<typeof createSchedulerLedger>;

function read<T>(
  outcome: { kind: 'available'; value: T } | { kind: 'unavailable' },
): T {
  if (outcome.kind === 'unavailable') throw new Error('unexpected unavailable');
  return outcome.value;
}

beforeEach(() => {
  rmSync(join(tempDir, 'scheduler'), { recursive: true, force: true });
  ledger = createSchedulerLedger();
});

function seed(job: Parameters<typeof ledger.create>[0]) {
  expect(ledger.create(job)).toEqual({ kind: 'created' });
}

type SchedulerChat = (agentSlug: string, prompt: string) => Promise<string>;

async function schedulerFor(chatFn: ReturnType<typeof vi.fn<SchedulerChat>>) {
  const { BuiltinScheduler } = await import('../builtin-scheduler.js');
  return new BuiltinScheduler({
    ledger,
    turnAdapter: {
      invoke: async ({ agentSlug, prompt }) => ({
        kind: 'completed',
        output: await chatFn(agentSlug, prompt),
      }),
    },
  });
}

// ── toScheduledJob: legacy-cron migration ──

describe('toScheduledJob — back-compat migration', () => {
  test('legacy job with only `cron` synthesizes a UTC cron schedule', () => {
    const scheduled = toScheduledJob({
      name: 'legacy',
      cron: '0 9 * * *',
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(scheduled).not.toBeNull();
    expect(scheduled!.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(scheduled!.createdMs).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(scheduled!.enabled).toBe(true);
    expect(scheduled!.lastRunMs).toBeUndefined();
  });

  test('job with `schedule` uses it directly (preferred over cron)', () => {
    const schedule = {
      kind: 'cron' as const,
      expr: '0 9 * * *',
      timezone: 'America/Denver',
    };
    const scheduled = toScheduledJob({
      name: 'tz-job',
      cron: '0 23 * * *',
      schedule,
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(scheduled).not.toBeNull();
    expect(scheduled!.schedule).toBe(schedule);
  });

  test('returns null when neither schedule nor cron is present', () => {
    expect(
      toScheduledJob({
        name: 'inert',
        prompt: 'p',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  test('disabled job carries enabled=false into the eval input', () => {
    const scheduled = toScheduledJob({
      name: 'off',
      cron: '0 9 * * *',
      prompt: 'p',
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(scheduled!.enabled).toBe(false);
  });
});

// ── Catch-up: host-down then boot ──

describe('catch-up after host-down', () => {
  test('isOverdue is true and missedCount reports the gap', () => {
    // Job created 7 days ago, last ran 7 days ago, daily cron.
    const createdMs = Date.parse('2026-03-01T09:00:00.000Z');
    const lastRunMs = Date.parse('2026-03-01T09:00:00.000Z');
    // Host boots 7 days later — 7 daily fires were missed.
    const nowMs = Date.parse('2026-03-08T08:00:00.000Z');
    const scheduled = {
      schedule: { kind: 'cron' as const, expr: '0 9 * * *' },
      createdMs,
      lastRunMs,
      enabled: true,
    };
    expect(isOverdue(scheduled, nowMs)).toBe(true);
    // 0 9 UTC each day: Mar 2, 3, 4, 5, 6, 7, 8 = 7 occurrences in
    // (Mar 1 09:00, Mar 8 08:00). The last (Mar 8 09:00) hasn't happened
    // yet at 08:00, so strictly-interior count is 6.
    const missed = missedCount(scheduled.schedule, lastRunMs, nowMs);
    expect(missed).toBe(6);
  });

  test('fire-once-not-N: tick() fires once after host-down', async () => {
    // Set up a job whose lastRunMs is far in the past. Drive a single tick
    // and assert the chatFn was called exactly once (not N times).
    const chatFn = vi.fn<SchedulerChat>().mockResolvedValue('ok');
    seed({
      name: 'catchup-job',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      prompt: 'p',
      enabled: true,
      createdAt: '2026-03-01T09:00:00.000Z',
      lastRunMs: Date.parse('2026-03-01T09:00:00.000Z'),
    });
    const scheduler = await schedulerFor(chatFn);
    // Call tick() directly (private) via a cast.
    (scheduler as any).tick();
    // tick() dispatches executeJob async; let it resolve.
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    const logs = read(ledger.logs('catchup-job'));
    expect(logs).toHaveLength(1);
    // missedCount should be > 0 (catch-up receipt).
    expect(logs[0].missedCount).toBeGreaterThan(0);
    // lastRunMs persisted after the successful fire.
    expect(
      read(ledger.list()).find((job) => job.name === 'catchup-job')?.lastRunMs,
    ).toBeDefined();
    await scheduler.stop();
  });

  test('two-tick: a recurring catch-up fire does not re-fire on the next tick', async () => {
    // The central invariant of the rebase: after a catch-up fire persists
    // lastRunMs, the NEXT tick must not re-fire (isOverdue reads the new
    // origin). Uses an `every` job with a long interval so the second tick
    // (a few ms later) is deterministic regardless of wall-clock time.
    const chatFn = vi.fn<SchedulerChat>().mockResolvedValue('ok');
    const everyMs = 60 * 60 * 1000; // hourly
    seed({
      name: 'catchup-twotick',
      schedule: { kind: 'every', everyMs },
      prompt: 'p',
      enabled: true,
      createdAt: new Date(Date.now() - 2 * everyMs).toISOString(),
      // 2 intervals overdue on the first tick.
      lastRunMs: Date.now() - 2 * everyMs,
    });
    const scheduler = await schedulerFor(chatFn);
    // First tick: overdue → fires once, persists lastRunMs = ~now.
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    // Second tick: lastRunMs is now ~now; next fire is +everyMs away → not
    // overdue. chatFn must still be 1× (the catch-up origin guards re-fire).
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  test('on-time fire reports missedCount 0', () => {
    // lastRunMs = exactly one interval ago (every 60s). The next fire is
    // on-time → missedCount 0.
    const scheduled = {
      schedule: { kind: 'every' as const, everyMs: 60_000 },
      createdMs: 0,
      lastRunMs: 1_000,
      enabled: true,
    };
    const nowMs = 61_000;
    expect(isOverdue(scheduled, nowMs)).toBe(true);
    expect(missedCount(scheduled.schedule, 1_000, 61_000)).toBe(0);
  });
});

// ── `at` one-shot self-disable ──

describe('at one-shot self-disable', () => {
  test('fires once, self-disables, and does not re-fire on deleteAfterRun', async () => {
    const chatFn = vi.fn<SchedulerChat>().mockResolvedValue('one-shot output');
    const fireAt = Date.now() - 1_000; // already passed
    seed({
      name: 'one-shot',
      schedule: {
        kind: 'at',
        timeMs: fireAt,
        deleteAfterRun: true,
      },
      prompt: 'p',
      enabled: true,
      createdAt: new Date(fireAt - 60_000).toISOString(),
    });
    const scheduler = await schedulerFor(chatFn);
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    // After the successful fire, the job is disabled (not deleted).
    const jobs = read(ledger.list());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].enabled).toBe(false);
    // A second tick must not re-fire.
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  test('at job without deleteAfterRun fires but stays enabled', async () => {
    const chatFn = vi.fn<SchedulerChat>().mockResolvedValue('sticky');
    const fireAt = Date.now() - 1_000;
    seed({
      name: 'sticky-at',
      schedule: { kind: 'at', timeMs: fireAt },
      prompt: 'p',
      enabled: true,
      createdAt: new Date(fireAt - 60_000).toISOString(),
    });
    const scheduler = await schedulerFor(chatFn);
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    // The job fired, lastRunMs now >= timeMs so isOverdue returns false —
    // it stays enabled but won't re-fire.
    expect(
      read(ledger.list()).find((job) => job.name === 'sticky-at')?.enabled,
    ).toBe(true);
    (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatFn).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

// ── DST: Denver 9am across the spring-forward boundary ──

describe('DST — Denver 9am cron across spring-forward', () => {
  test('projects to 09:00 America/Denver wall-clock on both sides of Mar 8 2026', () => {
    // US DST spring-forward in 2026 is Mar 8 (2:00 → 3:00 local).
    // 2026-03-07T16:00:00Z = 09:00 MST (UTC-7) in Denver.
    // 2026-03-08: Denver springs forward; 09:00 MDT = 15:00 UTC (UTC-6).
    // 2026-03-09: 09:00 MDT = 15:00 UTC.
    const denver9am: Schedule = {
      kind: 'cron',
      expr: '0 9 * * *',
      timezone: 'America/Denver',
    };
    // Start from Mar 7 00:00 UTC (before the Mar 7 09:00 MST fire).
    const fromMs = Date.parse('2026-03-07T00:00:00.000Z');
    const next3 = nextOccurrences(denver9am, 3, fromMs);
    expect(next3).toHaveLength(3);
    // Mar 7 09:00 MST = 16:00 UTC
    expect(next3[0]).toBe(Date.parse('2026-03-07T16:00:00.000Z'));
    // Mar 8 09:00 MDT = 15:00 UTC (after spring-forward)
    expect(next3[1]).toBe(Date.parse('2026-03-08T15:00:00.000Z'));
    // Mar 9 09:00 MDT = 15:00 UTC
    expect(next3[2]).toBe(Date.parse('2026-03-09T15:00:00.000Z'));
  });

  test('UTC cron would NOT shift — proving the DST engine is local-wall', () => {
    // The same 0 9 * * * in UTC fires at 09:00 UTC every day regardless of
    // DST — a quick sanity check that the timezone path is what carries the
    // shift. Both fire at the same UTC instant pre-DST; they diverge after.
    const utc9am: Schedule = { kind: 'cron', expr: '0 9 * * *' };
    const fromMs = Date.parse('2026-03-07T00:00:00.000Z');
    const next3 = nextOccurrences(utc9am, 3, fromMs);
    expect(next3[0]).toBe(Date.parse('2026-03-07T09:00:00.000Z'));
    expect(next3[1]).toBe(Date.parse('2026-03-08T09:00:00.000Z'));
    expect(next3[2]).toBe(Date.parse('2026-03-09T09:00:00.000Z'));
  });
});

// ── `every` anchored to lastRunMs ──

describe('every schedule anchored to lastRunMs', () => {
  test('nextOccurrence after a fire is anchored to lastRunMs, not the epoch', () => {
    const every: Schedule = { kind: 'every', everyMs: 60_000 };
    const lastRunMs = 1_000_000;
    const nowMs = lastRunMs + 30_000;
    // Not yet overdue — less than everyMs since lastRun.
    expect(
      isOverdue(
        { schedule: every, createdMs: 0, lastRunMs, enabled: true },
        nowMs,
      ),
    ).toBe(false);
    // Becomes overdue at lastRun + everyMs.
    expect(
      isOverdue(
        { schedule: every, createdMs: 0, lastRunMs, enabled: true },
        lastRunMs + 60_001,
      ),
    ).toBe(true);
    // nextOccurrence is anchored to fromMs, but the catch-up origin is
    // lastRunMs — so after a 5-minute gap, missedCount is 4 (the strictly
    // interior fires).
    expect(missedCount(every, lastRunMs, lastRunMs + 5 * 60_000)).toBe(4);
  });

  test('never-run every job becomes overdue after its first interval', () => {
    const every: Schedule = { kind: 'every', everyMs: 60_000 };
    const createdMs = 1_000_000;
    expect(
      isOverdue(
        { schedule: every, createdMs, enabled: true },
        createdMs + 59_999,
      ),
    ).toBe(false);
    expect(
      isOverdue(
        { schedule: every, createdMs, enabled: true },
        createdMs + 60_001,
      ),
    ).toBe(true);
  });
});

// ── getStoredJobView nextRun projection ──

describe('getStoredJobView nextRun', () => {
  test('nextRun uses ephemeris nextOccurrence for a schedule-bearing job', () => {
    seed({
      name: 'view-job',
      schedule: { kind: 'cron', expr: '0 0 * * *' },
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const view = read(ledger.listViews())[0];
    expect(view.nextRun).toBeDefined();
    // Daily at midnight UTC — nextRun is a parseable ISO instant.
    expect(() => new Date(view.nextRun!)).not.toThrow();
  });

  test('nextRun is undefined for a disabled job', () => {
    seed({
      name: 'disabled-view',
      cron: '0 0 * * *',
      prompt: 'p',
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const view = read(ledger.listViews())[0];
    expect(view.nextRun).toBeUndefined();
  });

  test('nextRun is undefined for a job with no schedule or cron', () => {
    seed({
      name: 'inert-view',
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const view = read(ledger.listViews())[0];
    expect(view.nextRun).toBeUndefined();
  });
});
