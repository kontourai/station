import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tempDir =
  process.env.STATION_HOME ||
  join(tmpdir(), `scheduler-eval-test-${process.pid}`);

const { createSchedulerLedger } = await import('../scheduler-ledger.js');
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

/** The recurring claims the ledger hands out at `now`, by job name. */
function claimsAt(now: number) {
  return read(ledger.claimDue(now)).map((receipt) => ({
    name: receipt.job.name,
    missedCount: receipt.missedCount,
  }));
}

function nextRunOf(name: string, now: number) {
  return read(ledger.listViews(now)).find((view) => view.name === name)
    ?.nextRun;
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

// ── Catch-up: host-down then boot ──

describe('catch-up after host-down', () => {
  test('a claim after host-down is one fire whose receipt counts the gap', () => {
    // Daily 09:00 UTC, last ran Mar 1 09:00; the host boots Mar 8 08:00.
    seed({
      name: 'host-down',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      prompt: 'p',
      enabled: true,
      createdAt: '2026-03-01T09:00:00.000Z',
      lastRunMs: Date.parse('2026-03-01T09:00:00.000Z'),
    });
    // Occurrences Mar 2..7 fall strictly inside (Mar 1 09:00, Mar 8 08:00);
    // Mar 8 09:00 has not happened yet, so six were missed.
    expect(claimsAt(Date.parse('2026-03-08T08:00:00.000Z'))).toEqual([
      { name: 'host-down', missedCount: 6 },
    ]);
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

  test('an on-time fire reports missedCount 0', () => {
    seed({
      name: 'on-time',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'p',
      enabled: true,
      createdAt: new Date(0).toISOString(),
      lastRunMs: 1_000,
    });
    expect(claimsAt(61_000)).toEqual([{ name: 'on-time', missedCount: 0 }]);
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

describe('DST — Denver 9am across spring-forward', () => {
  test('nextRun holds 09:00 Denver wall-clock on both sides of Mar 8 2026, while a legacy UTC cron does not shift', () => {
    seed({
      name: 'denver',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'America/Denver' },
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seed({
      name: 'legacy-utc',
      cron: '0 9 * * *',
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Mar 7 09:00 MST (UTC-7) is 16:00 UTC; after the spring-forward,
    // Mar 8 09:00 MDT (UTC-6) is 15:00 UTC.
    expect(nextRunOf('denver', Date.parse('2026-03-07T00:00:00.000Z'))).toBe(
      '2026-03-07T16:00:00.000Z',
    );
    expect(nextRunOf('denver', Date.parse('2026-03-07T16:00:01.000Z'))).toBe(
      '2026-03-08T15:00:00.000Z',
    );
    expect(
      nextRunOf('legacy-utc', Date.parse('2026-03-07T16:00:01.000Z')),
    ).toBe('2026-03-08T09:00:00.000Z');
  });
});

// ── `every` anchored to lastRunMs, or to createdAt before the first run ──

describe('every schedule anchoring', () => {
  test('a run job is anchored to lastRunMs, not createdAt, and counts interior misses from it', () => {
    const lastRunMs = 1_000_000;
    seed({
      name: 'anchored',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'p',
      enabled: true,
      // Anchored to createdAt, the job would be long overdue.
      createdAt: new Date(0).toISOString(),
      lastRunMs,
    });
    expect(claimsAt(lastRunMs + 30_000)).toEqual([]);
    // At +5 minutes, four occurrences fell strictly inside the gap.
    expect(claimsAt(lastRunMs + 5 * 60_000)).toEqual([
      { name: 'anchored', missedCount: 4 },
    ]);
  });

  test('a never-run job is anchored to createdAt: not due before its first interval, due after it', () => {
    const createdMs = Date.parse('2026-03-01T00:00:00.000Z');
    seed({
      name: 'never-run',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'p',
      enabled: true,
      createdAt: new Date(createdMs).toISOString(),
    });
    expect(claimsAt(createdMs + 59_999)).toEqual([]);
    expect(claimsAt(createdMs + 60_001).map(({ name }) => name)).toEqual([
      'never-run',
    ]);
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
    // Daily at midnight UTC. `new Date(x)` throws for nothing -- it yields an
    // Invalid Date -- so the previous `.not.toThrow()` passed for any string
    // the projection could emit. Parse it, and pin the midnight the cron
    // expression names.
    const nextRun = Date.parse(view.nextRun!);
    expect(Number.isNaN(nextRun)).toBe(false);
    expect(view.nextRun).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(nextRun).getUTCHours()).toBe(0);
    expect(new Date(nextRun).getUTCMinutes()).toBe(0);
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

  test('nextRun reads a legacy cron-only job as a UTC cron', () => {
    seed({
      name: 'legacy-cron',
      cron: '30 6 * * *',
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      nextRunOf('legacy-cron', Date.parse('2026-03-07T00:00:00.000Z')),
    ).toBe('2026-03-07T06:30:00.000Z');
  });

  test('nextRun follows `schedule` over a conflicting legacy cron', () => {
    seed({
      name: 'both',
      cron: '0 23 * * *',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'America/Denver' },
      prompt: 'p',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(nextRunOf('both', Date.parse('2026-03-07T00:00:00.000Z'))).toBe(
      '2026-03-07T16:00:00.000Z',
    );
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
