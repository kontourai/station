import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeExactProcessIdentity } from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSchedulerLogToRun } from '../../orchestration/run-projection.js';
import {
  ANNOUNCEMENT_LEASE_MS,
  ANNOUNCEMENT_OUTBOX_MIGRATION_KEY,
  ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX,
  ANNOUNCEMENT_SKIPPED_OLDER_THAN_RETENTION,
  createSchedulerLedger,
  FAILURE_ANNOUNCEMENT_RETENTION_MS,
  SCHEDULER_STARTER_CHECK_EVERY_MS,
  SCHEDULER_STARTER_CHECK_JOB_NAME,
  SCHEDULER_STARTER_CHECK_PROMPT,
  SCHEDULER_STARTER_MANUAL_INTENT_CAPACITY,
  SchedulerStorageCorruptError,
  SchedulerStorageUnavailableError,
} from '../scheduler-ledger.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
    };
    close(): void;
  };
};

const tempDir = join(tmpdir(), `scheduler-ledger-test-${process.pid}`);

function read<T>(
  outcome:
    | { kind: 'available'; value: T }
    | { kind: 'unavailable'; reason: string },
): T {
  if (outcome.kind === 'unavailable') throw new Error('unexpected unavailable');
  return outcome.value;
}

function starterJob(name = SCHEDULER_STARTER_CHECK_JOB_NAME) {
  return {
    name,
    schedule: {
      kind: 'every' as const,
      everyMs: SCHEDULER_STARTER_CHECK_EVERY_MS,
    },
    prompt: SCHEDULER_STARTER_CHECK_PROMPT,
    agent: 'station',
    enabled: false,
    notifyStart: false,
    retryCount: 0,
    createdAt: '2026-08-24T00:00:00.000Z',
  };
}

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SchedulerLedger', () => {
  test('durably replays one Starter manual intent before capacity and across restart', () => {
    let ledger = createSchedulerLedger({ directory: tempDir });
    const first = ledger.claimStarterManualIntent(
      'starter-operation-1',
      starterJob(),
      Date.parse('2026-08-24T01:00:00.000Z'),
    );
    if (first.kind !== 'claimed') throw new Error('expected Starter claim');
    const inFlight = ledger.claimStarterManualIntent(
      'starter-operation-1',
      starterJob(),
      Date.parse('2026-08-24T01:00:01.000Z'),
    );
    expect(inFlight).toMatchObject({
      kind: 'replayed',
      run: { id: `${first.receipt.id}-1`, state: 'running' },
    });
    expect(first.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    expect(
      first.receipt.settle({
        success: true,
        state: 'completed',
        completedAt: '2026-08-24T01:00:02.000Z',
        durationSecs: 2,
      }),
    ).toEqual({ kind: 'applied' });
    ledger.close();

    ledger = createSchedulerLedger({ directory: tempDir });
    expect(
      ledger.claimStarterManualIntent(
        'starter-operation-1',
        starterJob(),
        Date.parse('2026-08-24T02:00:00.000Z'),
      ),
    ).toMatchObject({
      kind: 'replayed',
      run: { id: `${first.receipt.id}-1`, success: true },
    });
    expect(ledger.remove(SCHEDULER_STARTER_CHECK_JOB_NAME)).toEqual({
      kind: 'removed',
    });
    expect(
      ledger.claimStarterManualIntent(
        'starter-operation-1',
        starterJob(),
        Date.parse('2026-08-24T02:00:01.000Z'),
      ),
    ).toMatchObject({
      kind: 'replayed',
      run: { id: `${first.receipt.id}-1`, success: true },
    });
    ledger.close();
  });

  test('recovers the exact Starter claim after post-commit response loss', () => {
    let throwOnce = true;
    const ledger = createSchedulerLedger({
      directory: tempDir,
      afterStarterIntentCommit: () => {
        if (!throwOnce) return;
        throwOnce = false;
        throw new Error('response lost after commit');
      },
    });
    const claimed = ledger.claimStarterManualIntent(
      'post-commit-operation',
      starterJob(),
      Date.parse('2026-08-24T01:00:00.000Z'),
    );
    expect(claimed).toMatchObject({ kind: 'claimed', replayed: true });
    if (claimed.kind !== 'claimed') throw new Error('expected exact readback');
    expect(
      ledger.claimStarterManualIntent(
        'post-commit-operation',
        starterJob(),
        Date.parse('2026-08-24T01:00:01.000Z'),
      ),
    ).toMatchObject({
      kind: 'replayed',
      run: { id: `${claimed.receipt.id}-1` },
    });
    ledger.close();
  });

  test('reclaims dead pre-invocation intent and quarantines dead invoked intent', () => {
    const first = createSchedulerLedger({ directory: tempDir });
    const prepared = first.claimStarterManualIntent(
      'dead-before-invocation',
      starterJob(),
      Date.parse('2026-08-24T01:00:00.000Z'),
    );
    if (prepared.kind !== 'claimed') throw new Error('expected Starter claim');
    first.close();

    const recovered = createSchedulerLedger({ directory: tempDir });
    const reclaimed = recovered.claimStarterManualIntent(
      'dead-before-invocation',
      starterJob(),
      Date.parse('2026-08-24T01:00:01.000Z'),
    );
    expect(reclaimed).toMatchObject({
      kind: 'claimed',
      replayed: true,
      receipt: { id: prepared.receipt.id },
    });
    if (reclaimed.kind !== 'claimed') throw new Error('expected reclaim');
    expect(
      recovered.releaseStarterManualIntent(
        'dead-before-invocation',
        reclaimed.receipt.id,
      ),
    ).toEqual({ kind: 'applied' });

    const invoked = recovered.claimStarterManualIntent(
      'dead-after-invocation',
      starterJob(),
      Date.parse('2026-08-24T01:00:02.000Z'),
    );
    if (invoked.kind !== 'claimed') throw new Error('expected invoked claim');
    expect(invoked.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    recovered.close();

    const observer = createSchedulerLedger({ directory: tempDir });
    expect(
      observer.claimStarterManualIntent(
        'dead-after-invocation',
        starterJob(),
        Date.parse('2026-08-24T01:00:03.000Z'),
      ),
    ).toMatchObject({
      kind: 'replayed',
      run: { id: `${invoked.receipt.id}-1`, state: 'indeterminate' },
    });
    observer.close();
  });

  test.each(['', 'control\u0000identity', 'x'.repeat(161)])(
    'rejects invalid Starter operation identity without writes',
    (operationId) => {
      const ledger = createSchedulerLedger({ directory: tempDir });
      expect(
        ledger.claimStarterManualIntent(
          operationId,
          starterJob(),
          Date.parse('2026-08-24T01:00:00.000Z'),
        ),
      ).toEqual({ kind: 'invalid' });
      expect(read(ledger.list())).toEqual([]);
      expect(read(ledger.runningLogs())).toEqual([]);
      ledger.close();
    },
  );

  test('rejects noncanonical jobs and preserves every admitted intent at the cap', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    for (
      let index = 0;
      index < SCHEDULER_STARTER_MANUAL_INTENT_CAPACITY;
      index++
    ) {
      const claimed = ledger.claimStarterManualIntent(
        `operation-${index}`,
        starterJob(),
        Date.parse('2026-08-24T01:00:00.000Z') + index * 1_000,
      );
      if (claimed.kind !== 'claimed') throw new Error('expected Starter claim');
      claimed.receipt.beginInvocation();
      expect(
        claimed.receipt.settle({
          success: true,
          state: 'completed',
          completedAt: new Date(
            Date.parse('2026-08-24T01:00:00.500Z') + index * 1_000,
          ).toISOString(),
          durationSecs: 0.5,
        }),
      ).toEqual({ kind: 'applied' });
    }
    expect(
      ledger.claimStarterManualIntent(
        'operation-0',
        starterJob(),
        Date.parse('2026-08-25T00:00:00.000Z'),
      ),
    ).toMatchObject({ kind: 'replayed' });
    expect(
      ledger.claimStarterManualIntent(
        'operation-0',
        starterJob('other-check'),
        Date.parse('2026-08-25T00:00:00.000Z'),
      ),
    ).toEqual({ kind: 'invalid' });
    expect(
      ledger.claimStarterManualIntent(
        'operation-over-cap',
        starterJob(),
        Date.parse('2026-08-25T00:00:00.000Z'),
      ),
    ).toEqual({ kind: 'capacity' });
    ledger.close();
  });

  test('refuses a user job collision and releases only an unstarted losing intent', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    expect(
      ledger.create({
        name: SCHEDULER_STARTER_CHECK_JOB_NAME,
        prompt: 'user-owned',
        enabled: false,
        createdAt: '2026-08-24T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'created' });
    expect(
      ledger.claimStarterManualIntent(
        'collision-operation',
        starterJob(),
        Date.parse('2026-08-24T01:00:00.000Z'),
      ),
    ).toEqual({ kind: 'conflict' });
    expect(read(ledger.runningLogs())).toEqual([]);
    expect(ledger.remove(SCHEDULER_STARTER_CHECK_JOB_NAME)).toEqual({
      kind: 'removed',
    });

    const prepared = ledger.claimStarterManualIntent(
      'released-operation',
      starterJob(),
      Date.parse('2026-08-24T01:00:01.000Z'),
    );
    if (prepared.kind !== 'claimed') throw new Error('expected Starter claim');
    expect(
      ledger.releaseStarterManualIntent(
        'released-operation',
        prepared.receipt.id,
      ),
    ).toEqual({ kind: 'applied' });
    expect(read(ledger.runningLogs())).toEqual([]);
    expect(read(ledger.list())).toEqual([]);
    expect(
      ledger.claimStarterManualIntent(
        'released-operation',
        starterJob(),
        Date.parse('2026-08-24T01:00:02.000Z'),
      ),
    ).toMatchObject({ kind: 'claimed' });
    ledger.close();
  });

  test('classifies an integrity I/O fault as unavailable before schema writes', () => {
    const fault = Object.assign(new Error('unable to open database file'), {
      code: 'SQLITE_CANTOPEN',
    });
    expect(() =>
      createSchedulerLedger({
        directory: tempDir,
        integrityCheck: () => ({ kind: 'unavailable', cause: fault }),
      }),
    ).toThrow(SchedulerStorageUnavailableError);
    const database = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    try {
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_jobs'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test('owns job creation, exact claim settlement, statistics, and output containment', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    expect(
      ledger.create({
        name: 'nightly',
        prompt: 'run',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'created' });

    const claimed = ledger.claimManual(
      'nightly',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    expect(claimed.kind).toBe('claimed');
    if (claimed.kind !== 'claimed') throw new Error('expected scheduler claim');
    expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    const output = claimed.receipt.outputPath();
    writeFileSync(output, 'ok');
    expect(
      claimed.receipt.settle({
        success: true,
        state: 'completed',
        completedAt: '2026-01-01T01:00:05.000Z',
        durationSecs: 5,
        output,
        terminal: true,
      }),
    ).toEqual({ kind: 'applied' });

    expect(read(ledger.stats())).toEqual({
      jobs: [
        {
          name: 'nightly',
          total: 1,
          successes: 1,
          failures: 0,
          success_rate: 100,
        },
      ],
    });
    expect(read(ledger.listViews())[0]).toMatchObject({
      name: 'nightly',
      lastRun: '2026-01-01T01:00:00.000Z',
    });
    expect(read(ledger.readOutput(output))).toBe('ok');

    const outside = join(tempDir, 'outside.log');
    writeFileSync(outside, 'nope');
    expect(ledger.readOutput(outside)).toEqual({
      kind: 'unavailable',
      reason: 'transient',
    });
    ledger.close();
  });

  test('returns the last N logs in execution order', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'nightly',
      prompt: 'run',
      enabled: true,
      retryCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = ledger.claimManual(
      'nightly',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    if (claim.kind !== 'claimed') throw new Error('expected scheduler claim');
    claim.receipt.beginInvocation();
    const retry = claim.receipt.recordNotInvoked({
      completedAt: '2026-01-01T01:00:01.000Z',
      error: 'one',
    });
    if (retry.kind !== 'claimed') throw new Error('expected retry capability');
    retry.receipt.beginInvocation();
    const final = retry.receipt.recordNotInvoked({
      completedAt: '2026-01-01T01:00:02.000Z',
      error: 'two',
    });
    if (final.kind !== 'claimed')
      throw new Error('expected final retry capability');
    final.receipt.beginInvocation();
    final.receipt.settle({
      success: true,
      state: 'completed',
      completedAt: '2026-01-01T01:00:03.000Z',
      durationSecs: 1,
      terminal: true,
    });

    expect(
      read(ledger.logs('nightly', 2)).map((entry) => entry.error ?? 'ok'),
    ).toEqual(['two', 'ok']);
    ledger.close();
  });

  test('serializes independent SQLite connections and never lets a stale completion restore an operator-deleted job', () => {
    const first = createSchedulerLedger({ directory: tempDir });
    const second = createSchedulerLedger({ directory: tempDir });
    first.create({
      name: 'operator-wins',
      prompt: 'first prompt',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = first.claimManual(
      'operator-wins',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    expect(claimed.kind).toBe('claimed');
    expect(
      second.claimManual(
        'operator-wins',
        Date.parse('2026-01-01T01:00:01.000Z'),
      ),
    ).toEqual({
      kind: 'busy',
    });
    expect(second.update('operator-wins', { prompt: 'operator edit' })).toEqual(
      {
        kind: 'updated',
      },
    );
    expect(second.remove('operator-wins')).toEqual({ kind: 'removed' });

    if (claimed.kind !== 'claimed') throw new Error('expected scheduler claim');
    expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    expect(
      claimed.receipt.settle({
        success: true,
        state: 'completed',
        completedAt: '2026-01-01T01:00:02.000Z',
        durationSecs: 1,
        terminal: true,
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      read(second.list()).find((job) => job.name === 'operator-wins'),
    ).toBeUndefined();
    expect(read(second.allLogs())).toMatchObject([
      { job: 'operator-wins', success: true },
    ]);
    first.close();
    second.close();
  });

  test('gives a delete-and-recreated display name a new server-issued principal', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    const job = {
      name: 'same-name',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    ledger.create(job);
    const first = ledger.claimManual(
      'same-name',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    if (first.kind !== 'claimed') throw new Error('expected first claim');
    const oldPrincipal = first.receipt.jobId;
    ledger.remove('same-name');
    ledger.create(job);
    const second = ledger.claimManual(
      'same-name',
      Date.parse('2026-01-01T01:00:01.000Z'),
    );
    if (second.kind !== 'claimed') throw new Error('expected second claim');
    expect(second.receipt.jobId).not.toBe(oldPrincipal);
    ledger.close();
  });

  test('does not let a recreated display name inherit its predecessor logs', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    const job = {
      name: 'history-isolated',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    ledger.create(job);
    const first = ledger.claimManual('history-isolated', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected first claim');
    first.receipt.beginInvocation();
    first.receipt.settle({
      success: true,
      state: 'completed',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
      terminal: true,
    });
    const firstId = first.receipt.jobId;
    ledger.remove('history-isolated');
    ledger.create(job);
    const second = ledger.claimManual('history-isolated', Date.now());
    if (second.kind !== 'claimed') throw new Error('expected second claim');

    expect(read(ledger.logs('history-isolated'))).toEqual([]);
    expect(read(ledger.allLogs())).toMatchObject([
      { job: 'history-isolated', jobId: firstId, success: true },
    ]);
    expect(second.receipt.jobId).not.toBe(firstId);
    ledger.close();
  });

  test('latches an invocation and rejects illegal settlement state combinations', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'legal-state',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = ledger.claimManual('legal-state', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected claim');

    expect(claim.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    expect(claim.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    expect(
      claim.receipt.settle({
        success: true,
        state: 'failed',
        completedAt: new Date().toISOString(),
        durationSecs: 0,
        terminal: true,
      }),
    ).toEqual({ kind: 'invalid' });
    expect(read(ledger.runningLogs('legal-state'))).toHaveLength(1);
    ledger.close();
  });

  test('consumes an exact overdue occurrence for indeterminate and exhausted pre-effect terminal outcomes', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'occurrence-once',
      cron: '0 * * * *',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const firedAt = Date.parse('2026-01-01T01:10:00.000Z');
    const due = read(ledger.claimDue(firedAt));
    expect(due).toHaveLength(1);
    expect(due[0]!.scheduledForMs).toBe(Date.parse('2026-01-01T01:00:00.000Z'));
    due[0]!.beginInvocation();
    due[0]!.settle({
      success: false,
      state: 'indeterminate',
      completedAt: '2026-01-01T01:10:01.000Z',
      durationSecs: 1,
      error: 'provider response was ambiguous',
      terminal: true,
    });
    expect(read(ledger.claimDue(firedAt))).toEqual([]);
    const next = read(ledger.claimDue(Date.parse('2026-01-01T02:10:00.000Z')));
    expect(next).toHaveLength(1);
    expect(next[0]!.scheduledForMs).toBe(
      Date.parse('2026-01-01T02:00:00.000Z'),
    );
    next[0]!.beginInvocation();
    next[0]!.settle({
      success: false,
      state: 'failed',
      completedAt: '2026-01-01T02:10:01.000Z',
      durationSecs: 1,
      error: 'definitely not invoked and retries exhausted',
      terminal: true,
    });
    expect(
      read(ledger.claimDue(Date.parse('2026-01-01T02:10:00.000Z'))),
    ).toEqual([]);
    ledger.close();
  });

  test('a manual receipt never consumes a recurring occurrence', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'manual-does-not-advance',
      cron: '0 * * * *',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const manual = ledger.claimManual(
      'manual-does-not-advance',
      Date.parse('2026-01-01T01:10:00.000Z'),
    );
    if (manual.kind !== 'claimed') throw new Error('expected manual claim');
    expect(manual.receipt.scheduledForMs).toBeUndefined();
    manual.receipt.beginInvocation();
    manual.receipt.settle({
      success: true,
      state: 'completed',
      completedAt: '2026-01-01T01:10:01.000Z',
      durationSecs: 1,
      terminal: true,
    });
    expect(
      read(ledger.claimDue(Date.parse('2026-01-01T01:10:00.000Z'))),
    ).toHaveLength(1);
    ledger.close();
  });

  test('reclaims the same recurring occurrence after a real deferred-claim release', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    const createdAt = Date.parse('2026-01-01T00:00:00.000Z');
    const dueAt = createdAt + 1_001;
    ledger.create({
      name: 'reclaim-after-deferral',
      schedule: { kind: 'every', everyMs: 1_000 },
      prompt: 'run',
      enabled: true,
      createdAt: new Date(createdAt).toISOString(),
    });

    const [deferred] = read(ledger.claimDue(dueAt));
    expect(deferred).toBeDefined();
    expect(deferred!.releaseDeferred()).toEqual({ kind: 'applied' });

    const [reclaimed] = read(ledger.claimDue(dueAt));
    expect(reclaimed).toMatchObject({
      scheduledForMs: deferred!.scheduledForMs,
      attempt: deferred!.attempt,
    });
    ledger.close();
  });

  test('long outages select the newest due occurrence without a synthetic catch-up cap', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    ledger.create({
      name: 'long-gap',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'run',
      enabled: true,
      createdAt: new Date(start).toISOString(),
      lastRunMs: start,
    });
    const dueAt = start + 2_000 * 60_000 + 1;
    const claim = read(ledger.claimDue(dueAt))[0]!;
    expect(claim.scheduledForMs).toBe(start + 2_000 * 60_000);
    ledger.close();
  });

  test('a decades-old minute cron resolves its newest occurrence without iterating every missed minute', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    const start = Date.parse('2000-01-01T00:00:00.000Z');
    const now = Date.parse('2026-01-01T00:00:30.000Z');
    ledger.create({
      name: 'decades-minute-cron',
      cron: '* * * * *',
      prompt: 'run',
      enabled: true,
      createdAt: new Date(start).toISOString(),
      lastRunMs: start,
    });
    const claim = read(ledger.claimDue(now))[0]!;
    expect(claim.scheduledForMs).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    ledger.close();
  });

  test('recognizes a durable settlement after a post-commit storage exception', () => {
    let throwAfterCommit = true;
    const ledger = createSchedulerLedger({
      directory: tempDir,
      afterSettlementCommit: () => {
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error('injected post-commit fault');
        }
      },
    });
    ledger.create({
      name: 'readback',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = ledger.claimManual(
      'readback',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    if (claimed.kind !== 'claimed') throw new Error('expected scheduler claim');
    claimed.receipt.beginInvocation();
    const settlement = {
      success: true,
      state: 'completed',
      completedAt: '2026-01-01T01:00:01.000Z',
      durationSecs: 1,
      terminal: true,
    } as const;
    expect(claimed.receipt.settle(settlement)).toEqual({ kind: 'applied' });
    expect(claimed.receipt.settle(settlement)).toEqual({ kind: 'applied' });
    expect(read(ledger.logs('readback'))).toHaveLength(1);
    ledger.close();
  });

  test('durably advances retry ownership and reconciles a closed same-process owner without replaying its prior attempt', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'restart-safe',
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = owner.claimManual(
      'restart-safe',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    if (first.kind !== 'claimed') throw new Error('expected scheduler claim');
    first.receipt.beginInvocation();
    const second = first.receipt.recordNotInvoked({
      completedAt: '2026-01-01T01:00:01.000Z',
      error: 'retry me',
    });
    if (second.kind !== 'claimed')
      throw new Error('expected durable retry claim');
    expect(second.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    owner.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    // Closing a same-PID owner makes its exact claim recoverable. The ledger
    // records the durable attempt-two uncertainty and never invokes attempt
    // one again; a fresh manual run is a new receipt, not a replay.
    const recovered = restarted.claimManual(
      'restart-safe',
      Date.parse('2026-01-01T01:00:02.000Z'),
    );
    expect(recovered.kind).toBe('claimed');
    expect(read(restarted.allLogs())).toMatchObject([
      { attempt: 1, error: 'retry me' },
      { attempt: 2, success: false },
    ]);
    restarted.close();
  });

  test('reclaims an advanced due retry after a crash before its next invocation without resetting its receipt or budget', () => {
    const started = Date.parse('2026-01-01T00:00:00.000Z');
    const dueAt = started + 1_001;
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'retry-crash-window',
      schedule: { kind: 'every', everyMs: 1_000 },
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: new Date(started).toISOString(),
    });
    const first = read(owner.claimDue(dueAt))[0]!;
    expect(first.attempt).toBe(1);
    expect(first.beginInvocation()).toEqual({ kind: 'applied' });
    const advanced = first.recordNotInvoked({
      completedAt: new Date(dueAt + 1).toISOString(),
      error: 'provider was unavailable before invocation',
    });
    if (advanced.kind !== 'claimed') throw new Error('expected retry receipt');
    const runId = advanced.receipt.id;
    expect(advanced.receipt.attempt).toBe(2);
    // Crash precisely after the atomic record+advance, before attempt two is
    // authorized to invoke. The next owner must reclaim this same receipt.
    owner.close();

    const firstRestart = createSchedulerLedger({ directory: tempDir });
    const reclaimed = read(firstRestart.claimDue(dueAt));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: runId,
      attempt: 2,
      maxAttempts: 2,
    });
    firstRestart.close();

    // Repeated crashes in the same window remain attempt two; they cannot
    // manufacture a fresh attempt one and exceed the configured retry budget.
    const secondRestart = createSchedulerLedger({ directory: tempDir });
    const reclaimedAgain = read(secondRestart.claimDue(dueAt));
    expect(reclaimedAgain).toHaveLength(1);
    expect(reclaimedAgain[0]).toMatchObject({
      id: runId,
      attempt: 2,
      maxAttempts: 2,
    });
    expect(read(secondRestart.allLogs())).toMatchObject([
      { id: `${runId}-1`, attempt: 1, state: 'failed' },
    ]);
    secondRestart.close();
  });

  /**
   * archive#3188. The birth fingerprint comes from `ps` under a 1500ms
   * timeout, and spawning is exactly what contends on a loaded host. When
   * that probe returned null, a crashed owner's occurrence became
   * permanently unreclaimable — the scheduler silently stopped retrying it —
   * and the failure surfaced as `expected [] to have a length of 1` on
   * whoever was gating rather than whoever caused it.
   *
   * `crashThenReclaim` drives the same crash-before-invocation window as the
   * test above; only the injected identity differs, so a regression here is
   * attributable to the probe and not to the retry path.
   */
  describe('a failed birth probe never strands a crashed claim', () => {
    /** A birth probe that fails, exactly as a timed-out `ps` does. */
    const failedBirth = {
      exact: () => null,
      probe: probeExactProcessIdentity,
    };

    function crashThenReclaim(
      ownerIdentity?: typeof failedBirth,
      restartIdentity?: typeof failedBirth,
    ) {
      const started = Date.parse('2026-01-01T00:00:00.000Z');
      const dueAt = started + 1_001;
      const owner = createSchedulerLedger({
        directory: tempDir,
        ...(ownerIdentity ? { processIdentity: ownerIdentity } : {}),
      });
      owner.create({
        name: 'retry-crash-window',
        schedule: { kind: 'every', everyMs: 1_000 },
        prompt: 'run',
        enabled: true,
        retryCount: 1,
        createdAt: new Date(started).toISOString(),
      });
      const first = read(owner.claimDue(dueAt))[0]!;
      expect(first.beginInvocation()).toEqual({ kind: 'applied' });
      const advanced = first.recordNotInvoked({
        completedAt: new Date(dueAt + 1).toISOString(),
        error: 'provider was unavailable before invocation',
      });
      if (advanced.kind !== 'claimed') throw new Error('expected retry');
      owner.close();

      const restart = createSchedulerLedger({
        directory: tempDir,
        ...(restartIdentity ? { processIdentity: restartIdentity } : {}),
      });
      const reclaimed = read(restart.claimDue(dueAt));
      restart.close();
      return reclaimed;
    }

    test('control: a working birth probe reclaims the crashed claim', () => {
      expect(crashThenReclaim()).toHaveLength(1);
    });

    test('an owner whose birth probe failed is still reclaimable', () => {
      expect(crashThenReclaim(failedBirth)).toHaveLength(1);
    });

    test('a restart whose own birth probe failed still reclaims', () => {
      expect(crashThenReclaim(undefined, failedBirth)).toHaveLength(1);
    });
  });

  test('returns a reclaimed manual retry to the manual caller with its immutable claimed job snapshot', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'manual-retry-snapshot',
      prompt: 'original prompt',
      agent: 'station',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = owner.claimManual('manual-retry-snapshot', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected manual claim');
    first.receipt.beginInvocation();
    const advanced = first.receipt.recordNotInvoked({
      completedAt: new Date().toISOString(),
      error: 'not invoked',
    });
    if (advanced.kind !== 'claimed') throw new Error('expected manual retry');
    const runId = advanced.receipt.id;
    owner.close();

    // An operator edit wins the future job definition but cannot rewrite the
    // already claimed retry's prompt/agent or make it a fresh attempt one.
    const editor = createSchedulerLedger({ directory: tempDir });
    expect(
      editor.update('manual-retry-snapshot', { prompt: 'new prompt' }),
    ).toEqual({ kind: 'updated' });
    editor.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    const reclaimed = restarted.claimManual(
      'manual-retry-snapshot',
      Date.now(),
    );
    expect(reclaimed).toMatchObject({
      kind: 'claimed',
      receipt: {
        id: runId,
        attempt: 2,
        job: { prompt: 'original prompt', agent: 'station' },
      },
    });
    restarted.close();
  });

  test('does not strand a dead manual retry when another manual caller recovers only its own capability', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    for (const name of ['manual-a', 'manual-b']) {
      owner.create({
        name,
        prompt: name,
        enabled: true,
        retryCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const first = owner.claimManual(name, Date.now());
      if (first.kind !== 'claimed') throw new Error('expected manual claim');
      first.receipt.beginInvocation();
      const advanced = first.receipt.recordNotInvoked({
        completedAt: new Date().toISOString(),
        error: 'not invoked',
      });
      if (advanced.kind !== 'claimed') throw new Error('expected retry');
    }
    owner.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    // A timer tick must not take ownership of either manual retry before the
    // corresponding operator asks for it.
    expect(read(restarted.claimDue(Date.now()))).toEqual([]);
    const a = restarted.claimManual('manual-a', Date.now());
    expect(a).toMatchObject({ kind: 'claimed', receipt: { attempt: 2 } });
    // Recovering A cannot quietly make B live under this owner. B remains
    // reclaimable by the exact manual caller rather than permanently busy.
    const b = restarted.claimManual('manual-b', Date.now());
    expect(b).toMatchObject({ kind: 'claimed', receipt: { attempt: 2 } });
    restarted.close();
  });

  test('operator deletion releases a dead advanced retry without resetting or leaving it running', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'deleted-advanced-retry',
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = owner.claimManual('deleted-advanced-retry', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected manual claim');
    first.receipt.beginInvocation();
    const advanced = first.receipt.recordNotInvoked({
      completedAt: new Date().toISOString(),
      error: 'not invoked',
    });
    if (advanced.kind !== 'claimed') throw new Error('expected retry');
    expect(owner.remove('deleted-advanced-retry')).toEqual({ kind: 'removed' });
    owner.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    expect(read(restarted.claimDue(Date.now()))).toEqual([]);
    expect(read(restarted.runningLogs())).toEqual([]);
    expect(read(restarted.allLogs())).toMatchObject([
      { id: `${advanced.receipt.id}-1`, state: 'failed', attempt: 1 },
    ]);
    restarted.close();
  });

  test('does not let an old attempt terminalize the atomically advanced retry', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'old-attempt',
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = ledger.claimManual('old-attempt', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected claim');
    first.receipt.beginInvocation();
    const advanced = first.receipt.recordNotInvoked({
      completedAt: new Date().toISOString(),
      error: 'not invoked',
    });
    if (advanced.kind !== 'claimed') throw new Error('expected retry');
    expect(
      first.receipt.settle({
        success: true,
        state: 'completed',
        completedAt: new Date().toISOString(),
        durationSecs: 0,
      }),
    ).toEqual({ kind: 'stale' });
    expect(advanced.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    ledger.close();
  });

  test('conservatively consumes a legacy invoked due claim without scheduledForMs', () => {
    const now = Date.parse('2026-01-01T01:00:00.000Z');
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'legacy-invoked',
      schedule: { kind: 'every', everyMs: 1_000 },
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = read(owner.claimDue(now))[0]!;
    expect(claim.beginInvocation()).toEqual({ kind: 'applied' });
    owner.close();

    const database = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    database
      .prepare('UPDATE scheduler_claims SET scheduled_for_ms = NULL')
      .run();
    database.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    // The missing legacy cursor is not permission to replay a possibly
    // invoked occurrence. Reconciliation emits indeterminate and moves the
    // cursor to this recovery instant.
    expect(read(restarted.claimDue(now))).toEqual([]);
    expect(read(restarted.allLogs())).toMatchObject([
      { id: `${claim.id}-1`, state: 'indeterminate' },
    ]);
    restarted.close();
  });

  test('reports a run abandoned by a dead owner so somebody can announce it', () => {
    // Reconciliation runs inside a claim read, far from any executing code,
    // and it writes a run the Schedule page will render as Failed. Before
    // this the run simply appeared, with no broadcast and no notification.
    const abandoned: Array<{ id: string; job: string; error?: string }> = [];
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'owner-died',
      schedule: { kind: 'every', everyMs: 1_000 },
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = read(
      owner.claimDue(Date.parse('2026-01-01T01:00:00.000Z')),
    )[0];
    if (!claim) throw new Error('expected a due claim');
    expect(claim.beginInvocation()).toEqual({ kind: 'applied' });
    owner.close();

    const restarted = createSchedulerLedger({
      directory: tempDir,
      onAbandonedRun: (entry) =>
        abandoned.push({ id: entry.id, job: entry.job, error: entry.error }),
    });
    expect(
      read(restarted.claimDue(Date.parse('2026-01-01T01:00:00.000Z'))),
    ).toEqual([]);

    expect(abandoned).toEqual([
      {
        id: `${claim.id}-1`,
        job: 'owner-died',
        error:
          'Scheduler process stopped after this run was claimed; invocation was not replayed automatically.',
      },
    ]);
    // Exactly what the durable log says — the announcement cannot describe a
    // run differently from the row it belongs to.
    expect(read(restarted.allLogs())).toMatchObject([
      { id: `${claim.id}-1`, state: 'indeterminate', success: false },
    ]);
    restarted.close();
  });

  test('startup settles a dead invoked manual claim even though no manual caller reclaims it', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'manual-possible-effect',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = owner.claimManual('manual-possible-effect', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected manual claim');
    expect(claim.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    owner.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    // A timer tick may never execute manual work, but it must still make a
    // dead possibly-invoked manual receipt honest rather than leave it live.
    expect(read(restarted.claimDue(Date.now()))).toEqual([]);
    expect(read(restarted.allLogs())).toMatchObject([
      { id: `${claim.receipt.id}-1`, manual: true, state: 'indeterminate' },
    ]);
    restarted.close();
  });

  test('reads back an atomically advanced or terminal proved-not-invoked result after commit throws', () => {
    let throws = 2;
    const ledger = createSchedulerLedger({
      directory: tempDir,
      afterNotInvokedCommit: () => {
        if (throws-- > 0) throw new Error('after commit');
      },
    });
    ledger.create({
      name: 'readback-retry',
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = ledger.claimManual('readback-retry', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected first claim');
    first.receipt.beginInvocation();
    const advanced = first.receipt.recordNotInvoked({
      completedAt: new Date().toISOString(),
      error: 'not invoked',
    });
    expect(advanced).toMatchObject({
      kind: 'claimed',
      receipt: { attempt: 2 },
    });
    if (advanced.kind !== 'claimed') throw new Error('expected retry receipt');
    advanced.receipt.beginInvocation();
    expect(
      advanced.receipt.recordNotInvoked({
        completedAt: new Date().toISOString(),
        error: 'not invoked again',
      }),
    ).toEqual({ kind: 'terminal' });
    ledger.close();
  });

  test('retries the same proved-not-invoked capability after its first post-write readback is unavailable', () => {
    let failReadback = true;
    const ledger = createSchedulerLedger({
      directory: tempDir,
      afterNotInvokedCommit: () => {
        throw new Error('native write completed before throw');
      },
      beforeNotInvokedReadback: () => {
        if (failReadback) {
          failReadback = false;
          throw new Error('transient readback fault');
        }
      },
    });
    ledger.create({
      name: 'retry-readback',
      prompt: 'run',
      enabled: true,
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = ledger.claimManual('retry-readback', Date.now());
    if (first.kind !== 'claimed') throw new Error('expected claim');
    first.receipt.beginInvocation();
    const input = {
      completedAt: new Date().toISOString(),
      error: 'not invoked',
    };
    expect(first.receipt.recordNotInvoked(input)).toEqual({
      kind: 'unavailable',
      // An injected readback fault, not damaged bytes (archive#3220).
      reason: 'transient',
    });
    expect(first.receipt.recordNotInvoked(input)).toMatchObject({
      kind: 'claimed',
      receipt: { attempt: 2 },
    });
    ledger.close();
  });

  test('projects the durable claim as running before invocation and exact indeterminate terminal state after a dead owner', () => {
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'visible-run',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = owner.claimManual(
      'visible-run',
      Date.parse('2026-01-01T01:00:00.000Z'),
    );
    if (claimed.kind !== 'claimed') throw new Error('expected claim');
    expect(
      projectSchedulerLogToRun(
        'built-in',
        read(owner.runningLogs('visible-run'))[0]!,
      ),
    ).toMatchObject({ status: 'running', sourceId: 'visible-run' });
    expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    owner.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    // Reconciliation happens before this unrelated claim. The invoked receipt
    // is durable uncertainty, not a second provider invocation.
    restarted.claimManual(
      'visible-run',
      Date.parse('2026-01-01T01:01:00.000Z'),
    );
    const terminal = read(restarted.allLogs())[0]!;
    expect(projectSchedulerLogToRun('built-in', terminal)).toMatchObject({
      status: 'failed',
      failureMessage: expect.stringContaining('not replayed'),
    });
    restarted.close();
  });

  test('fails closed rather than following a scheduler-root symlink outside Station home', () => {
    const outside = join(tmpdir(), `scheduler-ledger-outside-${process.pid}`);
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    symlinkSync(outside, join(tempDir, 'scheduler'));
    expect(() =>
      createSchedulerLedger({ directory: join(tempDir, 'scheduler') }),
    ).toThrow('must be a real directory');
    expect(existsSync(join(outside, 'scheduler.sqlite'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  test('detects corrupt scheduler bytes before schema writes and preserves them', () => {
    mkdirSync(tempDir, { recursive: true });
    const databasePath = join(tempDir, 'scheduler.sqlite');
    writeFileSync(databasePath, 'not a sqlite database');
    const before = readFileSync(databasePath);

    expect(() => createSchedulerLedger({ directory: tempDir })).toThrow(
      SchedulerStorageCorruptError,
    );
    expect(readFileSync(databasePath)).toEqual(before);
  });

  test('rejects symlinked database, logs roots, and output targets without writing outside the ledger', () => {
    const outside = join(
      tmpdir(),
      `scheduler-ledger-link-outside-${process.pid}`,
    );
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(outside, 'sentinel'), 'unchanged');

    symlinkSync(join(outside, 'sentinel'), join(tempDir, 'scheduler.sqlite'));
    expect(() => createSchedulerLedger({ directory: tempDir })).toThrow(
      'database must not be a symbolic link',
    );
    rmSync(join(tempDir, 'scheduler.sqlite'));
    rmSync(join(tempDir, 'logs'), { recursive: true, force: true });
    symlinkSync(outside, join(tempDir, 'logs'));
    expect(() => createSchedulerLedger({ directory: tempDir })).toThrow(
      'logs directory must be a real directory',
    );
    rmSync(join(tempDir, 'logs'));

    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'output-link',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = ledger.claimManual('output-link', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected claim');
    const target = join(tempDir, 'logs', `${claim.receipt.id}-1.log`);
    symlinkSync(join(outside, 'sentinel'), target);
    expect(() => claim.receipt.outputPath()).toThrow(
      'output target is not a regular file',
    );
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    ledger.close();
    rmSync(outside, { recursive: true, force: true });
  });

  // ── Announcement outbox ──
  //
  // A failed run is written durably and announced afterwards. Everything
  // below is about the gap between those two moments: before the outbox, a
  // process that died inside it left a Failed row that nobody was ever told
  // about and nothing would ever re-read.

  function announcementRow(id: string): {
    announced_at: string | null;
    announcement_skip_reason: string | null;
  } {
    const database = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    try {
      return database
        .prepare(
          'SELECT announced_at, announcement_skip_reason FROM scheduler_logs WHERE id = ?',
        )
        .get(id) as {
        announced_at: string | null;
        announcement_skip_reason: string | null;
      };
    } finally {
      database.close();
    }
  }

  test('every path that records a failed run leaves it owed, and only an announcement closes it', () => {
    // The four writers of a failed row, in one ledger: the settlement catch
    // path, the proved-not-invoked path (which is also the row the scheduler's
    // retained-recovery loop announces later — same insert, same attempt),
    // and dead-owner reconciliation. A successful run is recorded the same
    // way and is never announceable.
    const ledger = createSchedulerLedger({ directory: tempDir });
    for (const name of ['threw', 'never-invoked', 'succeeded']) {
      ledger.create({
        name,
        prompt: 'run',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const threw = ledger.claimManual('threw', Date.now());
    if (threw.kind !== 'claimed') throw new Error('expected a claim');
    threw.receipt.beginInvocation();
    expect(
      threw.receipt.settle({
        success: false,
        state: 'indeterminate',
        completedAt: new Date().toISOString(),
        durationSecs: 1,
        error: 'the engine threw',
      }),
    ).toEqual({ kind: 'applied' });

    const notInvoked = ledger.claimManual('never-invoked', Date.now());
    if (notInvoked.kind !== 'claimed') throw new Error('expected a claim');
    notInvoked.receipt.beginInvocation();
    expect(
      notInvoked.receipt.recordNotInvoked({
        completedAt: new Date().toISOString(),
        error: 'Engine never invoked: connection disabled',
      }),
    ).toEqual({ kind: 'terminal' });

    const succeeded = ledger.claimManual('succeeded', Date.now());
    if (succeeded.kind !== 'claimed') throw new Error('expected a claim');
    succeeded.receipt.beginInvocation();
    expect(
      succeeded.receipt.settle({
        success: true,
        state: 'completed',
        completedAt: new Date().toISOString(),
        durationSecs: 1,
      }),
    ).toEqual({ kind: 'applied' });

    // The dead-owner row, written by nobody's executing code.
    ledger.create({
      name: 'owner-died',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const abandoned = ledger.claimManual('owner-died', Date.now());
    if (abandoned.kind !== 'claimed') throw new Error('expected a claim');
    abandoned.receipt.beginInvocation();
    ledger.close();
    const restarted = createSchedulerLedger({ directory: tempDir });
    expect(read(restarted.claimDue(Date.now()))).toEqual([]);

    const failedIds = [
      `${threw.receipt.id}-1`,
      `${notInvoked.receipt.id}-1`,
      `${abandoned.receipt.id}-1`,
    ];
    for (const id of failedIds) {
      expect(announcementRow(id)).toEqual({
        announced_at: null,
        announcement_skip_reason: null,
      });
    }
    const outbox = restarted.announcementOutbox();
    const tokens = failedIds.map((id) => {
      const claim = outbox.claimAnnouncement(id);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      return claim.token;
    });
    expect(
      read(restarted.owedFailureAnnouncements()).entries.map((e) => e.id),
    ).toEqual(failedIds);
    // The successful run is never owed — it is not a failure, so there is
    // nothing to announce and nothing to stamp.
    expect(
      read(restarted.owedFailureAnnouncements()).entries.some(
        (entry) => entry.id === `${succeeded.receipt.id}-1`,
      ),
    ).toBe(false);

    failedIds.forEach((id, index) => outbox.markAnnounced(id, tokens[index]!));
    for (const id of failedIds) {
      const row = announcementRow(id);
      expect(typeof row.announced_at).toBe('string');
      // No skip reason: this row was announced, not dropped.
      expect(row.announcement_skip_reason).toBeNull();
      expect(outbox.claimAnnouncement(id)).toEqual({
        kind: 'already-announced',
      });
    }
    expect(read(restarted.owedFailureAnnouncements()).entries).toEqual([]);
    restarted.close();
  });

  test('an unannounced failure older than the retention window is stamped skipped, not announced', () => {
    // A Station that was off for a month must not open with a month of
    // notifications. The row stays exactly as it is on the Schedule page;
    // only the announcement is dropped, and the row says it was dropped.
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'stale-failure',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const now = Date.parse('2026-02-01T00:00:00.000Z');
    const recordedAt = now - FAILURE_ANNOUNCEMENT_RETENTION_MS - 60_000;
    const claim = ledger.claimManual('stale-failure', recordedAt);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    expect(
      claim.receipt.settle({
        success: false,
        state: 'indeterminate',
        completedAt: new Date(recordedAt).toISOString(),
        durationSecs: 0,
        error: 'nobody was ever told',
      }),
    ).toEqual({ kind: 'applied' });

    const id = `${claim.receipt.id}-1`;
    expect(read(ledger.owedFailureAnnouncements(now)).entries).toEqual([]);
    expect(announcementRow(id)).toEqual({
      announced_at: new Date(now).toISOString(),
      announcement_skip_reason: ANNOUNCEMENT_SKIPPED_OLDER_THAN_RETENTION,
    });
    // Stamped means settled: the sweep does not reconsider it next boot.
    expect(read(ledger.owedFailureAnnouncements(now)).entries).toEqual([]);

    // A failure inside the window is still owed, so the rule bounds the
    // backlog rather than switching announcements off.
    const fresh = ledger.claimManual('stale-failure', now);
    if (fresh.kind !== 'claimed') throw new Error('expected a claim');
    fresh.receipt.beginInvocation();
    fresh.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date(now).toISOString(),
      durationSecs: 0,
      error: 'this one is recent',
    });
    expect(
      read(ledger.owedFailureAnnouncements(now)).entries.map((e) => e.id),
    ).toEqual([`${fresh.receipt.id}-1`]);
    ledger.close();
  });

  /**
   * A scheduler ledger in its pre-outbox shape, with one historical failed
   * run. `predecessor` instead reproduces a database the EARLIER outbox build
   * already upgraded: columns present, its history stamped, no marker, plus a
   * genuinely owed failure it recorded afterwards.
   */
  function seedPreOutboxLedger(options: { predecessor?: boolean } = {}): void {
    mkdirSync(join(tempDir, 'logs'), { recursive: true });
    const legacy = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    // Every Station that ever opened this file put it in WAL, so a real
    // pre-outbox database is already there. Seeding a rollback-journal file
    // instead makes the concurrent test race on the WAL conversion — which
    // takes an exclusive lock that `busy_timeout` does not govern — rather
    // than on the migration it is meant to exercise.
    legacy.prepare('PRAGMA journal_mode = WAL').get();
    legacy
      .prepare(
        'CREATE TABLE scheduler_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      .run();
    legacy
      .prepare(
        `CREATE TABLE scheduler_jobs (
           name TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
           data TEXT NOT NULL, created_at TEXT NOT NULL, last_run_ms INTEGER)`,
      )
      .run();
    legacy
      .prepare(
        `CREATE TABLE scheduler_claims (
           run_id TEXT PRIMARY KEY, job_name TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
           revision INTEGER NOT NULL, started_at TEXT NOT NULL, started_ms INTEGER NOT NULL,
           job_data TEXT NOT NULL, scheduled_for_ms INTEGER, manual INTEGER NOT NULL,
           missed_count INTEGER NOT NULL, attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
           invocation_started INTEGER NOT NULL DEFAULT 0, owner_id TEXT NOT NULL,
           owner_pid INTEGER NOT NULL, owner_birth TEXT)`,
      )
      .run();
    // The pre-outbox shape: no announcement columns at all.
    legacy
      .prepare(
        `CREATE TABLE scheduler_logs (
           id TEXT NOT NULL UNIQUE, job_name TEXT NOT NULL, job_id TEXT, data TEXT NOT NULL,
           sequence INTEGER PRIMARY KEY AUTOINCREMENT)`,
      )
      .run();
    const job = {
      name: 'upgraded',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    legacy
      .prepare(
        'INSERT INTO scheduler_jobs(name, job_id, revision, data, created_at, last_run_ms) VALUES (?, ?, 1, ?, ?, NULL)',
      )
      .run('upgraded', 'legacy-job-id', JSON.stringify(job), job.createdAt);
    legacy
      .prepare(
        'INSERT INTO scheduler_logs(id, job_name, job_id, data) VALUES (?, ?, ?, ?)',
      )
      .run(
        'legacy-run-1',
        'upgraded',
        'legacy-job-id',
        JSON.stringify({
          id: 'legacy-run-1',
          job: 'upgraded',
          jobId: 'legacy-job-id',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          success: false,
          error: 'recorded before the outbox existed',
          state: 'failed',
        }),
      );
    if (options.predecessor) {
      // What the earlier outbox build leaves behind: the columns, its own
      // history already stamped, no marker — and then a real failure it
      // recorded and nobody has announced yet.
      for (const column of [
        'announced_at TEXT',
        'announcement_skip_reason TEXT',
        'announce_lease_until_ms INTEGER',
        'announce_lease_token TEXT',
      ]) {
        legacy.prepare(`ALTER TABLE scheduler_logs ADD COLUMN ${column}`).run();
      }
      legacy
        .prepare(
          'UPDATE scheduler_logs SET announced_at = ?, announcement_skip_reason = ?',
        )
        .run(new Date().toISOString(), ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX);
      legacy
        .prepare(
          'INSERT INTO scheduler_logs(id, job_name, job_id, data) VALUES (?, ?, ?, ?)',
        )
        .run(
          'predecessor-owed-1',
          'upgraded',
          'legacy-job-id',
          JSON.stringify({
            id: 'predecessor-owed-1',
            job: 'upgraded',
            jobId: 'legacy-job-id',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            success: false,
            error: 'recorded by the earlier outbox build; never announced',
            state: 'failed',
          }),
        );
    }
    legacy.close();
  }

  function migrationMarker(): string | undefined {
    const database = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    try {
      return (
        database
          .prepare('SELECT value FROM scheduler_ledger_meta WHERE key = ?')
          .get(ANNOUNCEMENT_OUTBOX_MIGRATION_KEY) as
          | { value: string }
          | undefined
      )?.value;
    } finally {
      database.close();
    }
  }

  test('upgrades a ledger written before the outbox without announcing its history', () => {
    // The column cannot simply appear: every existing row would read as
    // owed, so the first boot after an upgrade would announce the entire
    // history. Whether those runs were announced is not a fact this store
    // holds, and the row records that rather than claiming delivery.
    seedPreOutboxLedger();

    const ledger = createSchedulerLedger({ directory: tempDir });
    expect(read(ledger.owedFailureAnnouncements()).entries).toEqual([]);
    const migrated = announcementRow('legacy-run-1');
    expect(typeof migrated.announced_at).toBe('string');
    expect(migrated.announcement_skip_reason).toBe(
      ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX,
    );
    expect(typeof migrationMarker()).toBe('string');
    // The upgrade governs history only; the next failure is owed normally.
    const claim = ledger.claimManual('upgraded', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    claim.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
      error: 'after the upgrade',
    });
    expect(
      read(ledger.owedFailureAnnouncements()).entries.map((e) => e.id),
    ).toEqual([`${claim.receipt.id}-1`]);
    ledger.close();
  });

  test('adopts a database left by the earlier outbox build without closing its owed runs', () => {
    // The ambiguous state, and the dangerous one. An earlier build of this
    // upgrade added the columns and stamped its own history, then recorded
    // real failures — so this database has columns, no marker, stamped
    // history AND a genuinely owed run. Reading "no marker" as "nothing has
    // been classified yet" would stamp that owed failure as ancient history
    // and close it silently, which is the exact loss the outbox exists to
    // prevent. The columns say the classification already happened; only the
    // marker is missing, so write the marker and touch no rows.
    seedPreOutboxLedger({ predecessor: true });
    expect(migrationMarker()).toBeUndefined();
    expect(announcementRow('legacy-run-1').announcement_skip_reason).toBe(
      ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX,
    );
    expect(announcementRow('predecessor-owed-1').announced_at).toBeNull();

    const ledger = createSchedulerLedger({ directory: tempDir });
    expect(
      read(ledger.owedFailureAnnouncements()).entries.map((entry) => entry.id),
    ).toEqual(['predecessor-owed-1']);
    // History keeps the stamp the predecessor gave it, and the owed run keeps
    // its NULL until somebody actually announces it.
    expect(announcementRow('legacy-run-1').announcement_skip_reason).toBe(
      ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX,
    );
    expect(announcementRow('predecessor-owed-1').announced_at).toBeNull();
    expect(typeof migrationMarker()).toBe('string');
    ledger.close();
  });

  test('two processes upgrading one database at the same time both start cleanly', async () => {
    // Discovery outside the write lock is stale the instant the other
    // instance commits: the loser would re-add a column that now exists and
    // fail initialization outright. Two real processes, one pre-outbox
    // database, both must come up.
    seedPreOutboxLedger();
    const source = pathToFileURL(
      join(process.cwd(), 'src-server/services/scheduling/scheduler-ledger.ts'),
    ).href;
    const program = `
      import { createSchedulerLedger } from ${JSON.stringify(source)};
      const ledger = createSchedulerLedger({ directory: process.argv[1] });
      const owed = ledger.owedFailureAnnouncements();
      ledger.close();
      console.log(JSON.stringify({ ok: owed.kind, owed: owed.value?.entries?.length }));
    `;
    const children = [0, 1, 2].map(() =>
      spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', program, tempDir],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      ),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          err += String(chunk);
        });
        const [code] = (await once(child, 'exit')) as [number];
        return { code, out: out.trim(), err: err.trim() };
      }),
    );
    for (const result of results) {
      expect({ code: result.code, err: result.err }).toEqual({
        code: 0,
        err: '',
      });
      expect(JSON.parse(result.out)).toEqual({ ok: 'available', owed: 0 });
    }
    expect(typeof migrationMarker()).toBe('string');
  }, 30_000);

  test('a completed migration never re-stamps a genuinely owed run', () => {
    // The mirror hazard: blanket-stamping every NULL on each boot would be a
    // one-line "fix" for the half-state above and would silently discard the
    // owed runs this whole mechanism exists to keep. Once the marker is
    // there, a NULL means owed and must survive any number of restarts.
    const ledger = createSchedulerLedger({ directory: tempDir });
    expect(typeof migrationMarker()).toBe('string');
    ledger.create({
      name: 'still-owed',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = ledger.claimManual('still-owed', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    claim.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
      error: 'nobody has been told yet',
    });
    ledger.close();

    const restarted = createSchedulerLedger({ directory: tempDir });
    expect(
      read(restarted.owedFailureAnnouncements()).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([`${claim.receipt.id}-1`]);
    expect(announcementRow(`${claim.receipt.id}-1`)).toEqual({
      announced_at: null,
      announcement_skip_reason: null,
    });
    restarted.close();
  });

  test('two ledgers over one database let exactly one of them announce a run', () => {
    // Ordinary concurrency, not an ambiguous crash: a desktop Station and a
    // CLI over one home each sweep this table. Without an atomic claim both
    // read the same owed row and the user is told twice about one failure.
    const owner = createSchedulerLedger({ directory: tempDir });
    owner.create({
      name: 'contended',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = owner.claimManual('contended', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    claim.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
      error: 'both processes can see this',
    });
    const id = `${claim.receipt.id}-1`;

    const second = createSchedulerLedger({ directory: tempDir });
    const first = owner.announcementOutbox();
    const rival = second.announcementOutbox();
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    const held = first.claimAnnouncement(id, now);
    expect(held).toMatchObject({ kind: 'claimed', token: expect.any(String) });
    if (held.kind !== 'claimed') throw new Error('expected a claim');
    expect(rival.claimAnnouncement(id, now)).toEqual({
      kind: 'leased-elsewhere',
    });
    // Both still SEE the row as owed — the claim, not the read, is what
    // decides. Nothing is stamped until an announcement lands.
    expect(
      read(second.owedFailureAnnouncements(now)).entries.map((e) => e.id),
    ).toEqual([id]);

    // The holder died without stamping. The lease expires so the run is not
    // shut away forever; announcing it now is the at-least-once path.
    const successor = rival.claimAnnouncement(
      id,
      now + ANNOUNCEMENT_LEASE_MS + 1,
    );
    if (successor.kind !== 'claimed') throw new Error('expected a claim');

    // The expired claimant is not dead, only slow: its own release and stamp
    // must not touch the run its successor now owns. Without a token both
    // would land — clearing a live lease, or closing a run whose replacement
    // announcement is still in flight.
    first.releaseAnnouncement(id, held.token);
    expect(
      first.claimAnnouncement(id, now + ANNOUNCEMENT_LEASE_MS + 2),
    ).toEqual({ kind: 'leased-elsewhere' });
    first.markAnnounced(id, held.token);
    expect(announcementRow(id).announced_at).toBeNull();

    rival.markAnnounced(id, successor.token);
    expect(
      first.claimAnnouncement(id, now + ANNOUNCEMENT_LEASE_MS + 3),
    ).toEqual({ kind: 'already-announced' });
    expect(read(owner.owedFailureAnnouncements(now)).entries).toEqual([]);
    second.close();
    owner.close();
  });

  test('a released claim is immediately available to the other process', () => {
    // A claimant that could not deliver hands the run back rather than
    // making everyone else wait out its lease.
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'handed-back',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = ledger.claimManual('handed-back', Date.now());
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    claim.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
      error: 'delivery failed',
    });
    const id = `${claim.receipt.id}-1`;
    const outbox = ledger.announcementOutbox();
    const now = Date.now();
    const claimed = outbox.claimAnnouncement(id, now);
    if (claimed.kind !== 'claimed') throw new Error('expected a claim');
    expect(outbox.claimAnnouncement(id, now)).toEqual({
      kind: 'leased-elsewhere',
    });
    outbox.releaseAnnouncement(id, claimed.token);
    expect(outbox.claimAnnouncement(id, now)).toMatchObject({
      kind: 'claimed',
    });
    // A run this store has never heard of is not silently suppressed.
    expect(outbox.claimAnnouncement('no-such-run-1', now)).toEqual({
      kind: 'unknown',
    });
    ledger.close();
  });

  test('announces a failure exactly at the retention boundary and one whose timestamps cannot be read', () => {
    // The rule is "older THAN the window", so a run exactly at the boundary
    // is still announced — the boundary is the last moment it counts, not
    // the first moment it does not.
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.create({
      name: 'boundary',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const now = Date.parse('2026-02-01T00:00:00.000Z');
    const exactlyAtBoundary = now - FAILURE_ANNOUNCEMENT_RETENTION_MS;
    const claim = ledger.claimManual('boundary', exactlyAtBoundary);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    claim.receipt.beginInvocation();
    claim.receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt: new Date(exactlyAtBoundary).toISOString(),
      durationSecs: 0,
      error: 'exactly seven days old',
    });
    expect(
      read(ledger.owedFailureAnnouncements(now)).entries.map((e) => e.id),
    ).toEqual([`${claim.receipt.id}-1`]);
    ledger.close();

    // A row the sweep cannot date is announced rather than aged out: the
    // retention rule exists to bound a flood, and it must not become a way
    // for a malformed row to silence itself.
    const database = new DatabaseSync(join(tempDir, 'scheduler.sqlite'));
    database
      .prepare(
        'INSERT INTO scheduler_logs(id, job_name, job_id, data) VALUES (?, ?, ?, ?)',
      )
      .run(
        'undateable-1',
        'boundary',
        'boundary-job-id',
        JSON.stringify({
          id: 'undateable-1',
          job: 'boundary',
          startedAt: 'not-a-date',
          completedAt: 'also-not-a-date',
          success: false,
          error: 'nothing here parses',
          state: 'failed',
        }),
      );
    database.close();

    const reopened = createSchedulerLedger({ directory: tempDir });
    expect(
      read(reopened.owedFailureAnnouncements(now)).entries.map(
        (entry) => entry.id,
      ),
    ).toContain('undateable-1');
    expect(announcementRow('undateable-1').announced_at).toBeNull();
    reopened.close();
  });

  test('returns a typed unavailable mutation outcome when its SQLite authority is closed', () => {
    const ledger = createSchedulerLedger({ directory: tempDir });
    ledger.close();
    expect(
      ledger.create({
        name: 'unavailable',
        prompt: 'run',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'unavailable', reason: 'transient' });
  });

  test('a live child owns one receipt and its killed owner is reconciled exactly once', async () => {
    const source = pathToFileURL(
      join(process.cwd(), 'src-server/services/scheduling/scheduler-ledger.ts'),
    ).href;
    const program = `
      import { createSchedulerLedger } from ${JSON.stringify(source)};
      const ledger = createSchedulerLedger({ directory: process.argv[1] });
      ledger.create({ name: 'child-owned', prompt: 'run', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' });
      const claim = ledger.claimManual('child-owned', Date.parse('2026-01-01T01:00:00.000Z'));
      console.log(JSON.stringify(claim.kind));
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program, tempDir],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let exited = false;
    let contender: ReturnType<typeof createSchedulerLedger> | undefined;
    try {
      const [line] = (await once(child.stdout!, 'data')) as [Buffer];
      expect(JSON.parse(line.toString())).toBe('claimed');

      contender = createSchedulerLedger({ directory: tempDir });
      expect(contender.claimManual('child-owned', Date.now())).toEqual({
        kind: 'busy',
      });
      child.kill('SIGKILL');
      await once(child, 'exit');
      exited = true;

      const recovered = contender.claimManual('child-owned', Date.now());
      expect(recovered.kind).toBe('claimed');
      expect(read(contender.logs('child-owned'))).toHaveLength(0);
    } finally {
      contender?.close();
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  test('a killed child after beginInvocation is recorded indeterminate and never replayed', async () => {
    const source = pathToFileURL(
      join(process.cwd(), 'src-server/services/scheduling/scheduler-ledger.ts'),
    ).href;
    const program = `
      import { createSchedulerLedger } from ${JSON.stringify(source)};
      const ledger = createSchedulerLedger({ directory: process.argv[1] });
      ledger.create({ name: 'child-invoked', prompt: 'run', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' });
      const claim = ledger.claimManual('child-invoked', Date.parse('2026-01-01T01:00:00.000Z'));
      if (claim.kind === 'claimed') claim.receipt.beginInvocation();
      console.log(JSON.stringify(claim.kind));
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program, tempDir],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let exited = false;
    let ledger: ReturnType<typeof createSchedulerLedger> | undefined;
    try {
      await once(child.stdout!, 'data');
      child.kill('SIGKILL');
      await once(child, 'exit');
      exited = true;

      ledger = createSchedulerLedger({ directory: tempDir });
      const next = ledger.claimManual('child-invoked', Date.now());
      expect(next.kind).toBe('claimed');
      const logs = read(ledger.allLogs());
      expect(logs).toMatchObject([{ state: 'indeterminate', attempt: 1 }]);
      expect(logs).toHaveLength(1);
    } finally {
      ledger?.close();
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  test('an operator delete wins a timer-process completion without losing its immutable receipt', async () => {
    const parent = createSchedulerLedger({ directory: tempDir });
    parent.create({
      name: 'operator-delete-process',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const source = pathToFileURL(
      join(process.cwd(), 'src-server/services/scheduling/scheduler-ledger.ts'),
    ).href;
    const program = `
      import { createSchedulerLedger } from ${JSON.stringify(source)};
      const ledger = createSchedulerLedger({ directory: process.argv[1] });
      const claim = ledger.claimManual('operator-delete-process', Date.parse('2026-01-01T01:00:00.000Z'));
      if (claim.kind === 'claimed') claim.receipt.beginInvocation();
      console.log(JSON.stringify({ phase: 'claimed', kind: claim.kind }));
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => {
        const outcome = claim.kind === 'claimed' ? claim.receipt.settle({
          success: true, state: 'completed', completedAt: '2026-01-01T01:00:01.000Z', durationSecs: 1, terminal: true,
        }) : claim;
        console.log(JSON.stringify({ phase: 'settled', outcome }));
        ledger.close();
        process.exit(0);
      });
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program, tempDir],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let exited = false;
    try {
      const [claimed] = (await once(child.stdout!, 'data')) as [Buffer];
      expect(JSON.parse(claimed.toString())).toMatchObject({
        phase: 'claimed',
        kind: 'claimed',
      });

      expect(
        parent.update('operator-delete-process', { prompt: 'new' }),
      ).toEqual({
        kind: 'updated',
      });
      expect(parent.remove('operator-delete-process')).toEqual({
        kind: 'removed',
      });
      const settledLine = once(child.stdout!, 'data');
      child.stdin!.write('settle\n');
      const [settled] = (await settledLine) as [Buffer];
      expect(JSON.parse(settled.toString())).toMatchObject({
        phase: 'settled',
        outcome: { kind: 'applied' },
      });
      await once(child, 'exit');
      exited = true;

      expect(read(parent.list())).toEqual([]);
      expect(read(parent.allLogs())).toMatchObject([
        {
          job: 'operator-delete-process',
          state: 'completed',
          success: true,
        },
      ]);
    } finally {
      parent.close();
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  test('simultaneous terminal appends from independent processes retain both receipts', async () => {
    const parent = createSchedulerLedger({ directory: tempDir });
    parent.create({
      name: 'parent-append',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    parent.create({
      name: 'child-append',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const parentClaim = parent.claimManual('parent-append', Date.now());
    if (parentClaim.kind !== 'claimed')
      throw new Error('expected parent claim');
    parentClaim.receipt.beginInvocation();
    const source = pathToFileURL(
      join(process.cwd(), 'src-server/services/scheduling/scheduler-ledger.ts'),
    ).href;
    const program = `
      import { createSchedulerLedger } from ${JSON.stringify(source)};
      const ledger = createSchedulerLedger({ directory: process.argv[1] });
      const claim = ledger.claimManual('child-append', Date.parse('2026-01-01T01:00:00.000Z'));
      if (claim.kind === 'claimed') claim.receipt.beginInvocation();
      console.log(JSON.stringify(claim.kind));
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => {
        console.log(JSON.stringify(claim.kind === 'claimed' ? claim.receipt.settle({
          success: true, state: 'completed', completedAt: '2026-01-01T01:00:01.000Z', durationSecs: 1, terminal: true,
        }) : claim));
        ledger.close();
        process.exit(0);
      });
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program, tempDir],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let exited = false;
    try {
      const [claimed] = (await once(child.stdout!, 'data')) as [Buffer];
      expect(JSON.parse(claimed.toString())).toBe('claimed');
      const settledLine = once(child.stdout!, 'data');
      child.stdin!.write('settle\n');
      expect(
        parentClaim.receipt.settle({
          success: true,
          state: 'completed',
          completedAt: '2026-01-01T01:00:01.000Z',
          durationSecs: 1,
          terminal: true,
        }),
      ).toEqual({ kind: 'applied' });
      const [settled] = (await settledLine) as [Buffer];
      expect(JSON.parse(settled.toString())).toEqual({ kind: 'applied' });
      await once(child, 'exit');
      exited = true;

      expect(
        read(parent.allLogs())
          .map((entry) => entry.job)
          .sort(),
      ).toEqual(['child-append', 'parent-append']);
    } finally {
      parent.close();
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});
