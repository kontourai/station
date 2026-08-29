import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../__test-utils__/read-json.js';
import { createLogger } from '../../utils/logger.js';
import { SCHEDULER_LOG_BINDING_KEYS } from '../../utils/logger-correlation.js';
import { createServerLogReader } from '../infra/server-log-reader.js';
import {
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../infra/server-log-store.js';

// ── Temp dir isolation — respect the shared test home override if present ──

const tempDir =
  process.env.STATION_HOME || join(tmpdir(), `scheduler-test-${process.pid}`);

// Mock chatFn for executeJob tests
let chatFnBehavior: { ok: boolean; text: string } = { ok: true, text: 'done' };
const mockChatFn = vi.fn(async () => {
  if (!chatFnBehavior.ok) throw new Error('Agent error');
  return chatFnBehavior.text;
});

// Must import AFTER mock so module-level constants use the mocked homedir
const { BuiltinScheduler } = await import('../scheduling/builtin-scheduler.js');
const { ANNOUNCEMENT_LEASE_MS, createSchedulerLedger } = await import(
  '../scheduling/scheduler-ledger.js'
);
type BuiltinSchedulerOptions =
  import('../scheduling/builtin-scheduler.js').BuiltinSchedulerOptions;
const { resetAnnouncedSchedulerFailuresForTests } = await import(
  '../scheduling/builtin-scheduler-execution.js'
);
const { SchedulerService } = await import('../scheduling/scheduler-service.js');
const { schedulerJobDuration, schedulerJobRuns } = await import(
  '../../telemetry/metrics.js'
);
const { createSchedulerRoutes } = await import(
  '../../routes/operations/scheduler.js'
);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

function createBuiltin(
  options: { logger?: BuiltinSchedulerOptions['logger'] } = {},
) {
  return new BuiltinScheduler({
    ...options,
    turnAdapter: {
      invoke: async () => {
        try {
          return { kind: 'completed' as const, output: await mockChatFn() };
        } catch (error) {
          return {
            kind: 'indeterminate' as const,
            error: error instanceof Error ? error.message : 'failed',
          };
        }
      },
    },
  });
}

function createSchedulerService() {
  return new SchedulerService({
    logger: mockLogger,
    builtin: {
      turnAdapter: {
        invoke: async () => {
          try {
            return { kind: 'completed' as const, output: await mockChatFn() };
          } catch (error) {
            return {
              kind: 'indeterminate' as const,
              error: error instanceof Error ? error.message : 'failed',
            };
          }
        },
      },
    },
  });
}

beforeEach(() => {
  rmSync(join(tempDir, 'scheduler'), { recursive: true, force: true });
  mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The announcement dedupe is keyed by run id and lives for the process; run
// ids are unique in production but a test corpus is one process.
beforeEach(() => {
  resetAnnouncedSchedulerFailuresForTests();
});

/**
 * A real ledger whose next `recordNotInvoked` answers are scripted, so the
 * retained-capability path (`unavailable` → later resolution) is reachable
 * without a storage fault. Everything else — including the resolving call —
 * is the real ledger's own behaviour.
 */
function ledgerWithScriptedNotInvoked(
  real: ReturnType<typeof createSchedulerLedger>,
  unavailableAnswers: number,
) {
  let remaining = unavailableAnswers;
  const wrap = (receipt: any) => ({
    ...receipt,
    recordNotInvoked: (input: { completedAt: string; error: string }) => {
      if (remaining > 0) {
        remaining -= 1;
        return { kind: 'unavailable' as const, reason: 'transient' as const };
      }
      return receipt.recordNotInvoked(input);
    },
  });
  return new Proxy(real, {
    get(target: any, prop: string | symbol) {
      if (prop === 'claimManual') {
        return (name: string, now: number) => {
          const outcome = target.claimManual(name, now);
          return outcome.kind === 'claimed'
            ? { kind: 'claimed', receipt: wrap(outcome.receipt) }
            : outcome;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ReturnType<typeof createSchedulerLedger>;
}

// ── Cron Engine ──

// nextCronTimes tests removed with cron.ts (archive#1940) — the cron engine
// is now @kontourai/ephemeris's schedule core, tested in
// src-server/services/scheduling/__tests__/builtin-scheduler-eval.test.ts.

// ── BuiltinScheduler CRUD ──

describe('BuiltinScheduler', () => {
  let scheduler: InstanceType<typeof BuiltinScheduler>;

  beforeEach(() => {
    scheduler = createBuiltin();
  });

  afterEach(() => {
    scheduler.stop();
  });

  test('addJob creates a job and listJobs returns it', async () => {
    await scheduler.addJob({
      name: 'test-job',
      prompt: 'do stuff',
      cron: '0 * * * *',
    });
    const jobs = await scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'test-job',
      prompt: 'do stuff',
      cron: '0 * * * *',
      enabled: true,
      provider: 'built-in',
      unattendedPrincipal: { kind: 'scheduled-job', jobId: expect.any(String) },
    });
  });

  test('addJob rejects duplicate names', async () => {
    await scheduler.addJob({ name: 'dup', prompt: 'a' });
    await expect(
      scheduler.addJob({ name: 'dup', prompt: 'b' }),
    ).rejects.toThrow("Job 'dup' already exists");
  });

  test('replays a Starter manual operation without invoking the job twice', async () => {
    mockChatFn.mockClear();
    const first = scheduler.prepareStarterManualIntent('starter-operation-1');
    expect(first).toMatchObject({
      replayed: false,
      reference: {
        kind: 'receipt',
        owner: 'scheduler-run',
        id: expect.any(String),
      },
    });
    if (!first.activate) throw new Error('expected activation capability');
    const receipt = await first.activate();
    expect(receipt).toMatchObject({
      outcome: 'completed',
      runId: first.reference.id,
    });
    const replay = scheduler.prepareStarterManualIntent('starter-operation-1');
    expect(replay).toMatchObject({
      replayed: true,
      reference: first.reference,
      receipt,
    });
    expect(replay.activate).toBeUndefined();
    expect(mockChatFn).toHaveBeenCalledTimes(1);
  });

  test('keeps an explicit Starter operation interactive under degraded posture', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'completed',
      output: 'ready',
    });
    const deferred = new BuiltinScheduler({
      ledger: createSchedulerLedger({
        directory: join(tempDir, 'starter-resource-deferral'),
      }),
      turnAdapter: { invoke },
      resourcePosture: {
        observe: async () => ({
          kind: 'degraded',
          busyPercent: 90,
          cpuCount: 8,
          sampledAt: 100,
          sampleMs: 500,
          thresholdPercent: 85,
          source: 'test',
        }),
      },
    });
    try {
      const prepared = deferred.prepareStarterManualIntent(
        'starter-resource-operation',
      );
      if (!prepared.activate) throw new Error('expected activation capability');
      await expect(prepared.activate()).resolves.toMatchObject({
        outcome: 'completed',
        runId: prepared.reference.id,
      });
      expect(invoke).toHaveBeenCalledOnce();
      await expect(
        deferred.getJobLogs('station-starter-check'),
      ).resolves.toMatchObject([
        {
          id: expect.any(String),
          state: 'completed',
        },
      ]);
      expect(
        deferred.prepareStarterManualIntent('starter-resource-operation'),
      ).toMatchObject({
        replayed: true,
        completion: 'completed',
        reference: prepared.reference,
      });
    } finally {
      await deferred.stop();
    }
  });

  test('startup tick preserves a dead pre-invocation Starter claim for exact reclaim', async () => {
    const directory = join(tempDir, 'starter-restart-order');
    const invoke = vi.fn(async () => ({
      kind: 'completed' as const,
      output: 'ready',
    }));
    const abandoned = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory }),
      turnAdapter: { invoke },
    });
    const prepared = abandoned.prepareStarterManualIntent(
      'starter-restart-operation',
    );
    await abandoned.stop();

    const restarted = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory }),
      turnAdapter: { invoke },
    });
    try {
      restarted.start();
      const reclaimed = restarted.prepareStarterManualIntent(
        'starter-restart-operation',
      );
      expect(reclaimed).toMatchObject({
        replayed: true,
        reference: prepared.reference,
        activate: expect.any(Function),
      });
      await expect(reclaimed.activate?.()).resolves.toMatchObject({
        outcome: 'completed',
        runId: prepared.reference.id,
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      const terminalReplay = restarted.prepareStarterManualIntent(
        'starter-restart-operation',
      );
      expect(terminalReplay).toMatchObject({
        replayed: true,
        completion: 'completed',
        reference: prepared.reference,
      });
      expect(terminalReplay.activate).toBeUndefined();
    } finally {
      await restarted.stop();
    }
  });

  /**
   * The retained not-invoked capability: `recordNotInvoked` answered
   * `unavailable`, so the execution path could not announce anything, and the
   * transition landed later inside the scheduler's own recovery loop. The
   * failed row is durable at that moment and nothing else will ever mention
   * it — these three tests pin that it is announced, and announced ONCE.
   */
  async function runWithScriptedNotInvoked(options: {
    name: string;
    directory: string;
    retryCount: number;
    unavailableAnswers: number;
    invoke: BuiltinSchedulerOptions['turnAdapter']['invoke'];
  }) {
    const real = createSchedulerLedger({
      directory: join(tempDir, options.directory),
    });
    const ledger =
      options.unavailableAnswers > 0
        ? ledgerWithScriptedNotInvoked(real, options.unavailableAnswers)
        : real;
    const schedule = vi.fn();
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: { invoke: options.invoke },
      notificationService: {
        dispatch: (_name: string, effect: () => unknown) => effect(),
        schedule,
      } as never,
    });
    const events: Array<Record<string, unknown>> = [];
    scheduler.subscribe((data) => events.push(JSON.parse(data)));
    try {
      await scheduler.addJob({
        name: options.name,
        prompt: 'go',
        retryCount: options.retryCount,
      });
      const receipt = await scheduler.runJob(options.name);
      const failed = events.filter((e) => e.event === 'job.failed');
      return {
        receipt,
        failed,
        schedule,
        logs: await scheduler.getJobLogs(options.name),
      };
    } finally {
      await scheduler.stop();
    }
  }

  test('a retained not-invoked capability that resolves terminal is announced exactly once', async () => {
    const { receipt, failed, schedule, logs } = await runWithScriptedNotInvoked(
      {
        name: 'retained-terminal',
        directory: 'announce-retained-terminal',
        retryCount: 0,
        unavailableAnswers: 2,
        invoke: vi.fn().mockResolvedValue({
          kind: 'definitely-not-invoked' as const,
          error: 'adapter unavailable before invocation',
        }),
      },
    );

    expect(receipt.outcome).toBe('failed');
    const reason =
      'Engine never invoked: adapter unavailable before invocation';
    // The durable row and the announcement say the same thing.
    expect(logs).toMatchObject([{ success: false, error: reason }]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      job: 'retained-terminal',
      error: reason,
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      'scheduler',
      expect.objectContaining({ body: reason }),
    );
  });

  test('a retained not-invoked capability that resolves claimed announces its durable prior attempt once', async () => {
    const { failed, schedule, logs } = await runWithScriptedNotInvoked({
      name: 'retained-claimed',
      directory: 'announce-retained-claimed',
      retryCount: 1,
      unavailableAnswers: 2,
      invoke: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'definitely-not-invoked' as const,
          error: 'adapter unavailable before invocation',
        })
        .mockResolvedValueOnce({
          kind: 'completed' as const,
          output: 'retry ok',
        }),
    });

    const reason =
      'Engine never invoked: adapter unavailable before invocation';
    // Attempt 1 failed durably and attempt 2 succeeded: exactly one failure
    // row, exactly one announcement, and it names attempt 1's reason.
    expect(logs.filter((l) => !l.success)).toMatchObject([{ error: reason }]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ job: 'retained-claimed', error: reason });
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('a not-invoked run whose transition lands immediately is announced once, not twice', async () => {
    // The immediate path already announces. The recovery path must not be
    // reached here at all, and if a future change routes both, the dedupe in
    // `announceSchedulerJobFailure` still has to hold.
    const { failed, schedule } = await runWithScriptedNotInvoked({
      name: 'immediate-terminal',
      directory: 'announce-immediate-terminal',
      retryCount: 0,
      unavailableAnswers: 0,
      invoke: vi.fn().mockResolvedValue({
        kind: 'definitely-not-invoked' as const,
        error: 'adapter unavailable before invocation',
      }),
    });

    expect(failed).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('a run abandoned by a dead owner reaches the user like any other failure', async () => {
    // Nothing is executing when reconciliation writes this run, so before the
    // ledger reported it the Failed row simply appeared with no broadcast and
    // nothing in the bell.
    const dead = createSchedulerLedger({
      directory: join(tempDir, 'scheduler'),
    });
    dead.create({
      name: 'abandoned',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = dead.claimManual('abandoned', Date.now());
    if (claimed.kind !== 'claimed') throw new Error('expected a manual claim');
    expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    dead.close();

    const schedule = vi.fn();
    const restarted = new BuiltinScheduler({
      turnAdapter: { invoke: vi.fn() },
      notificationService: {
        dispatch: (_name: string, effect: () => unknown) => effect(),
        schedule,
      } as never,
    });
    const events: Array<Record<string, unknown>> = [];
    restarted.subscribe((data) => events.push(JSON.parse(data)));
    restarted.start();
    restarted.stop();

    const failed = events.find((event) => event.event === 'job.failed');
    expect(failed).toMatchObject({
      job: 'abandoned',
      id: `${claimed.receipt.id}-1`,
      error:
        'Scheduler process stopped after this run was claimed; invocation was not replayed automatically.',
    });
    expect(schedule).toHaveBeenCalledWith(
      'scheduler',
      expect.objectContaining({
        category: 'job-failure',
        title: 'Job "abandoned" failed',
        body: 'Scheduler process stopped after this run was claimed; invocation was not replayed automatically.',
      }),
    );
  });

  /**
   * The announcement outbox.
   *
   * A failed run becomes durable inside a transaction and is announced after
   * it commits. A process that dies in that window used to lose the
   * announcement entirely: the buffer carrying it was in memory, and the
   * in-process dedupe Set that a restart clears was the only thing that ever
   * asked "has this been announced?". The run's own row answers now.
   */
  function seedFailureNobodyWasToldAbout(directory: string): string {
    const dead = createSchedulerLedger({ directory });
    dead.create({
      name: 'crashed-before-announcing',
      prompt: 'run',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = dead.claimManual('crashed-before-announcing', Date.now());
    if (claimed.kind !== 'claimed') throw new Error('expected a manual claim');
    expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
    dead.close();

    // Reconciliation with no listener attached is exactly the durable state a
    // crash between COMMIT and the flush leaves behind: the Failed row
    // exists, and nothing anywhere announced it.
    const unflushed = createSchedulerLedger({ directory });
    expect(unflushed.claimDue(Date.now())).toMatchObject({
      kind: 'available',
      value: [],
    });
    unflushed.close();
    return `${claimed.receipt.id}-1`;
  }

  /**
   * A scheduler over `directory` whose notification service behaves like the
   * real one: `dispatch` ADMITS a task to an async queue and the write
   * happens inside it, so queue admission and persistence are separable —
   * which is the whole point of the two options here.
   *
   * `admit: false` is shutdown (nothing is ever queued). `stamp: false` is a
   * process that dies after the notification is durable but before the row
   * records it.
   */
  function schedulerOver(
    directory: string,
    options: { admit?: boolean; stamp?: boolean } = {},
  ) {
    const schedule = vi.fn(async () => ({}));
    const events: Array<Record<string, unknown>> = [];
    const real = createSchedulerLedger({ directory });
    const ledger = options.stamp === false ? ledgerThatNeverStamps(real) : real;
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: { invoke: vi.fn() },
      notificationService: {
        dispatch: (_name: string, task: () => Promise<unknown>) => {
          if (options.admit === false) return false;
          void task().catch(() => undefined);
          return true;
        },
        schedule,
      } as never,
    });
    scheduler.subscribe((data) => events.push(JSON.parse(data)));
    return {
      scheduler,
      schedule,
      failures: () => events.filter((event) => event.event === 'job.failed'),
    };
  }

  /** Announces normally, then dies before the row can record it. */
  function ledgerThatNeverStamps(
    real: ReturnType<typeof createSchedulerLedger>,
  ) {
    return new Proxy(real, {
      get(target: any, prop: string | symbol) {
        if (prop === 'announcementOutbox') {
          return () => ({ ...target.announcementOutbox(), markAnnounced() {} });
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ReturnType<typeof createSchedulerLedger>;
  }

  function owedIds(directory: string): string[] {
    const ledger = createSchedulerLedger({ directory });
    try {
      const outcome = ledger.owedFailureAnnouncements();
      if (outcome.kind !== 'available') throw new Error('unexpected outcome');
      return outcome.value.entries.map((entry) => entry.id);
    } finally {
      ledger.close();
    }
  }

  test('announces a failure the previous process recorded but died before reporting', async () => {
    const directory = join(tempDir, 'announcement-outbox-recovered');
    const runId = seedFailureNobodyWasToldAbout(directory);

    const booted = schedulerOver(directory);
    booted.scheduler.start();
    await booted.scheduler.stop();

    expect(booted.failures()).toHaveLength(1);
    expect(booted.failures()[0]).toMatchObject({
      job: 'crashed-before-announcing',
      id: runId,
      error:
        'Scheduler process stopped after this run was claimed; invocation was not replayed automatically.',
    });
    expect(booted.schedule).toHaveBeenCalledWith(
      'scheduler',
      expect.objectContaining({
        category: 'job-failure',
        title: 'Job "crashed-before-announcing" failed',
      }),
    );
  });

  test('does not announce the same recovered failure again on the next start', async () => {
    const directory = join(tempDir, 'announcement-outbox-stamped');
    seedFailureNobodyWasToldAbout(directory);

    const booted = schedulerOver(directory);
    booted.scheduler.start();
    await booted.scheduler.stop();
    expect(booted.failures()).toHaveLength(1);

    // A restart clears the in-process dedupe Set, so silence here can only
    // come from the stamp the first boot wrote on the run itself.
    resetAnnouncedSchedulerFailuresForTests();
    const restarted = schedulerOver(directory);
    restarted.scheduler.start();
    await restarted.scheduler.stop();

    expect(restarted.failures()).toEqual([]);
    expect(restarted.schedule).not.toHaveBeenCalled();
  });

  test('a refused notification dispatch leaves the failure owed for the next start', async () => {
    // `dispatch` returns false while the notification service is shutting
    // down: nothing is queued and no bell entry will ever exist. Stamping on
    // admission alone would record a delivery that never happened — the same
    // silent loss, moved one layer down. The SSE broadcast is not a
    // substitute; it is ephemeral and may have no subscriber.
    const directory = join(tempDir, 'announcement-outbox-refused');
    const runId = seedFailureNobodyWasToldAbout(directory);

    const refused = schedulerOver(directory, { admit: false });
    refused.scheduler.start();
    await refused.scheduler.stop();
    expect(refused.schedule).not.toHaveBeenCalled();
    expect(owedIds(directory)).toEqual([runId]);

    resetAnnouncedSchedulerFailuresForTests();
    const recovered = schedulerOver(directory);
    recovered.scheduler.start();
    await recovered.scheduler.stop();
    expect(recovered.schedule).toHaveBeenCalledTimes(1);
    expect(owedIds(directory)).toEqual([]);
  });

  test('recovers a failure left leased by a crashed process without waiting for another boot', async () => {
    // The ordinary crash-recovery path: a Station dies mid-announcement and
    // comes back seconds later, well inside its dead predecessor's 60s lease.
    // A boot-only sweep meets `leased-elsewhere`, returns, and never looks
    // again — the failure would then stay silent for the entire life of the
    // restarted process. The sweep arms one re-sweep for just after the lease
    // expires instead, so recovery needs no second restart.
    const directory = join(tempDir, 'announcement-outbox-crash-window');
    seedFailureNobodyWasToldAbout(directory);

    // Date plus the timer wheel: the re-sweep is armed against both.
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    try {
      vi.setSystemTime(Date.parse('2026-03-01T00:00:00.000Z'));
      const crashed = schedulerOver(directory, { stamp: false });
      crashed.scheduler.start();
      await crashed.scheduler.stop();
      expect(crashed.schedule).toHaveBeenCalledTimes(1);
      // Durable state after the crash: announced to nobody's satisfaction —
      // the row is still owed, and still leased by the process that died.
      expect(owedIds(directory)).toHaveLength(1);

      resetAnnouncedSchedulerFailuresForTests();
      const restarted = schedulerOver(directory);
      restarted.scheduler.start();
      expect(restarted.schedule).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_LEASE_MS + 600);
      expect(restarted.schedule).toHaveBeenCalledTimes(1);
      expect(restarted.failures()).toHaveLength(1);
      expect(owedIds(directory)).toEqual([]);

      // And exactly once: nothing re-arms after the row is stamped.
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_LEASE_MS * 3);
      expect(restarted.schedule).toHaveBeenCalledTimes(1);
      await restarted.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('two schedulers over one home announce a recovered failure exactly once', async () => {
    // Ordinary concurrency: a desktop Station and a CLI over the same home
    // both sweep this table at boot. The lease, not the stamp, is what stops
    // the duplicate here — the second scheduler starts while the first one's
    // notification write is still in flight.
    const directory = join(tempDir, 'announcement-outbox-two-stations');
    seedFailureNobodyWasToldAbout(directory);

    const first = schedulerOver(directory);
    const second = schedulerOver(directory);
    first.scheduler.start();
    // Two PROCESSES: the in-process dedupe Set is per-process, so leaving
    // this test's shared one populated would hide the very race it exists to
    // pin (it did — an injected always-claim lease passed until this line).
    // The second scheduler starts while the first one's notification write
    // is still in flight, so nothing is stamped yet and only the lease can
    // prevent the duplicate.
    resetAnnouncedSchedulerFailuresForTests();
    second.scheduler.start();
    await first.scheduler.stop();
    await second.scheduler.stop();

    expect([...first.failures(), ...second.failures()]).toHaveLength(1);
    expect(
      first.schedule.mock.calls.length + second.schedule.mock.calls.length,
    ).toBe(1);
    expect(owedIds(directory)).toEqual([]);
  });

  test('admits a manual run under degraded posture instead of treating it as cron', async () => {
    const ledger = createSchedulerLedger({
      directory: join(tempDir, 'manual-resource-posture'),
    });
    const invoke = vi.fn().mockResolvedValue({
      kind: 'completed',
      output: 'manual output',
    });
    const manualScheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: { invoke },
      resourcePosture: {
        observe: async () => ({
          kind: 'degraded' as const,
          busyPercent: 90,
          cpuCount: 8,
          sampledAt: 100,
          sampleMs: 500,
          thresholdPercent: 85,
          source: 'test',
        }),
      },
    });
    try {
      await manualScheduler.addJob({ name: 'manual-posture', prompt: 'run' });

      await expect(manualScheduler.runJob('manual-posture')).resolves.toEqual(
        expect.objectContaining({ outcome: 'completed' }),
      );
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await manualScheduler.stop();
    }
  });

  test('addJob validates name is required', async () => {
    await expect(scheduler.addJob({ name: '', prompt: 'x' })).rejects.toThrow(
      'Job name is required',
    );
  });

  test('addJob validates prompt is required', async () => {
    await expect(scheduler.addJob({ name: 'x', prompt: '' })).rejects.toThrow(
      'Job prompt is required',
    );
  });

  test('editJob updates allowed fields', async () => {
    await scheduler.addJob({
      name: 'edit-me',
      prompt: 'original',
      cron: '0 * * * *',
    });
    await scheduler.editJob('edit-me', {
      prompt: 'updated',
      cron: '*/5 * * * *',
    });
    const jobs = await scheduler.listJobs();
    expect(jobs[0]).toMatchObject({ prompt: 'updated', cron: '*/5 * * * *' });
  });

  test('editJob blocks protected fields', async () => {
    await scheduler.addJob({ name: 'protect-me', prompt: 'test' });
    const before = (await scheduler.listJobs())[0];
    await scheduler.editJob('protect-me', {
      name: 'hacked',
      createdAt: '1999-01-01',
    } as any);
    const after = (await scheduler.listJobs())[0];
    expect(after.name).toBe('protect-me');
    expect((after as any).createdAt).toBe((before as any).createdAt);
  });

  test('editJob throws for non-existent job', async () => {
    await expect(scheduler.editJob('ghost', { prompt: 'x' })).rejects.toThrow(
      "Job 'ghost' not found",
    );
  });

  test('removeJob deletes the job', async () => {
    await scheduler.addJob({ name: 'rm-me', prompt: 'bye' });
    await scheduler.removeJob('rm-me');
    expect(await scheduler.listJobs()).toHaveLength(0);
  });

  test('removeJob throws for non-existent job', async () => {
    await expect(scheduler.removeJob('nope')).rejects.toThrow(
      "Job 'nope' not found",
    );
  });

  test('enableJob / disableJob toggles enabled flag', async () => {
    await scheduler.addJob({
      name: 'toggle',
      prompt: 'test',
      cron: '0 * * * *',
    });
    await scheduler.disableJob('toggle');
    expect((await scheduler.listJobs())[0].enabled).toBe(false);
    await scheduler.enableJob('toggle');
    expect((await scheduler.listJobs())[0].enabled).toBe(true);
  });

  test('runJob throws for non-existent job', async () => {
    await expect(scheduler.runJob('missing')).rejects.toThrow(
      "Job 'missing' not found",
    );
  });

  test('getStats returns zero-based stats for jobs with no runs', async () => {
    await scheduler.addJob({ name: 'no-runs', prompt: 'test' });
    const stats = await scheduler.getStats();
    expect(stats.jobs[0]).toMatchObject({
      name: 'no-runs',
      total: 0,
      successes: 0,
      failures: 0,
      success_rate: 0,
    });
  });

  test('getStatus reflects running state', async () => {
    expect((await scheduler.getStatus()).running).toBe(false);
    scheduler.start();
    expect((await scheduler.getStatus()).running).toBe(true);
    scheduler.stop();
    expect((await scheduler.getStatus()).running).toBe(false);
  });

  test('getJobLogs returns empty for job with no runs', async () => {
    await scheduler.addJob({ name: 'no-logs', prompt: 'test' });
    expect(await scheduler.getJobLogs('no-logs')).toEqual([]);
  });

  test('previewSchedule returns ISO strings', async () => {
    const previews = await scheduler.previewSchedule('0 12 * * *', 2);
    expect(previews).toHaveLength(2);
    previews.forEach((p) => expect(() => new Date(p)).not.toThrow());
  });

  test('subscribe / unsubscribe manages SSE clients', () => {
    const messages: string[] = [];
    const unsub = scheduler.subscribe((d) => messages.push(d));
    // Trigger a broadcast indirectly via start (tick won't match, but we can test subscribe works)
    unsub();
    // After unsubscribe, no more messages
    expect(typeof unsub).toBe('function');
  });

  test('listJobs includes nextRun for enabled cron jobs', async () => {
    await scheduler.addJob({
      name: 'cron-job',
      prompt: 'test',
      cron: '0 * * * *',
    });
    const jobs = await scheduler.listJobs();
    expect(jobs[0].nextRun).toBeDefined();
    expect(() => new Date(jobs[0].nextRun!)).not.toThrow();
  });

  test('listJobs omits nextRun for disabled jobs', async () => {
    await scheduler.addJob({
      name: 'disabled-job',
      prompt: 'test',
      cron: '0 * * * *',
    });
    await scheduler.disableJob('disabled-job');
    const jobs = await scheduler.listJobs();
    expect(jobs[0].nextRun).toBeUndefined();
  });

  test('runJob executes and creates log entry', async () => {
    chatFnBehavior = { ok: true, text: 'job output here' };
    await scheduler.addJob({ name: 'exec-job', prompt: 'do stuff' });
    const receipt = await scheduler.runJob('exec-job');
    await new Promise((r) => setTimeout(r, 50));
    const logs = await scheduler.getJobLogs('exec-job');
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(true);
    expect(logs[0].job).toBe('exec-job');
    expect(logs[0].durationSecs).toBeGreaterThanOrEqual(0);
    expect(receipt).toMatchObject({
      outcome: 'completed',
      runId: `schedule:built-in:exec-job:${logs[0]!.id}`,
    });
  });

  test('runJob records failure on agent error', async () => {
    chatFnBehavior = { ok: false, text: '' };
    await scheduler.addJob({ name: 'fail-job', prompt: 'break' });
    await scheduler.runJob('fail-job');
    await new Promise((r) => setTimeout(r, 50));
    const logs = await scheduler.getJobLogs('fail-job');
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(false);
  });

  test('runJob writes output file readable through the provider file guard', async () => {
    chatFnBehavior = { ok: true, text: 'captured output' };
    await scheduler.addJob({ name: 'output-job', prompt: 'test' });
    await scheduler.runJob('output-job');
    await new Promise((r) => setTimeout(r, 50));
    const logs = await scheduler.getJobLogs('output-job');
    expect(logs[0].output).toBeTruthy();
    const output = await scheduler.readRunFile(logs[0].output!);
    expect(output).toBe('captured output');
  });

  test('runJob broadcasts started and completed events', async () => {
    chatFnBehavior = { ok: true, text: 'ok' };
    const events: any[] = [];
    scheduler.subscribe((d) => events.push(JSON.parse(d)));
    await scheduler.addJob({ name: 'event-job', prompt: 'test' });
    await scheduler.runJob('event-job');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      events.some((e) => e.event === 'job.started' && e.job === 'event-job'),
    ).toBe(true);
    expect(
      events.some((e) => e.event === 'job.completed' && e.job === 'event-job'),
    ).toBe(true);
  });

  test('runJob broadcasts failed event on error', async () => {
    chatFnBehavior = { ok: false, text: '' };
    const events: any[] = [];
    scheduler.subscribe((d) => events.push(JSON.parse(d)));
    await scheduler.addJob({ name: 'fail-event-job', prompt: 'test' });
    await scheduler.runJob('fail-event-job');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      events.some(
        (e) => e.event === 'job.failed' && e.job === 'fail-event-job',
      ),
    ).toBe(true);
  });

  test('start observers cannot block the durable invocation claim', async () => {
    const observerFault = createBuiltin({
      logger: {
        child: () => {
          throw new Error('logger observer unavailable');
        },
      } as any,
    });
    try {
      chatFnBehavior = { ok: true, text: 'still invoked' };
      await observerFault.addJob({ name: 'observer-start', prompt: 'go' });
      await expect(
        observerFault.runJob('observer-start'),
      ).resolves.toMatchObject({
        outcome: 'completed',
      });
      expect(
        (await observerFault.getJobLogs('observer-start'))[0],
      ).toMatchObject({
        success: true,
        state: 'completed',
      });
    } finally {
      await observerFault.stop();
    }
  });

  test('stop aborts a durable pre-effect retry delay before it authorizes another invocation', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'definitely-not-invoked' as const,
        error: 'agent unavailable before invocation',
      })
      .mockResolvedValueOnce({
        kind: 'completed' as const,
        output: 'retry ok',
      });
    const retrying = new BuiltinScheduler({
      turnAdapter: { invoke },
    });
    try {
      await retrying.addJob({
        name: 'stop-during-delay',
        prompt: 'go',
        retryCount: 1,
        // Comfortably larger than vi.waitFor's ~50ms poll interval. At 30ms
        // the test hinged on waitFor's immediate first check catching
        // invoke-1: one extra microtask hop on the attempt path (e.g. the
        // resource-posture admission await) pushed the call past that check,
        // the next poll landed after the delay had elapsed, and attempt 2
        // invoked before stop() ran. The property under test is stop-during-
        // delay ordering, which does not depend on the delay being 30ms.
        retryDelaySecs: 0.25,
      });
      const running = retrying.runJob('stop-during-delay');
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      const stopping = retrying.stop();
      const [receipt] = await Promise.all([running, stopping]);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(receipt).toMatchObject({
        outcome: 'indeterminate',
        runId: expect.stringMatching(/-2$/),
      });
    } finally {
      await retrying.stop();
    }
  });

  test('a retried manual receipt points at its final attempt log', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'definitely-not-invoked' as const,
        error: 'agent unavailable before invocation',
      })
      .mockResolvedValueOnce({
        kind: 'completed' as const,
        output: 'retry ok',
      });
    const retrying = new BuiltinScheduler({ turnAdapter: { invoke } });
    try {
      await retrying.addJob({
        name: 'retry-run-correlation',
        prompt: 'go',
        retryCount: 1,
      });
      const receipt = await retrying.runJob('retry-run-correlation');
      const logs = await retrying.getJobLogs('retry-run-correlation');
      const final = logs.at(-1)!;
      expect(receipt).toMatchObject({
        outcome: 'completed',
        runId: `schedule:built-in:retry-run-correlation:${final.id}`,
      });
      expect(final.attempt).toBe(2);
    } finally {
      await retrying.stop();
    }
  });

  test('retries an exact advanced receipt after transient not-invoked readback ambiguity without leaving the job busy', async () => {
    let throwAfterCommit = true;
    let throwReadback = true;
    const ledger = createSchedulerLedger({
      directory: join(tempDir, 'retry-not-invoked-readback'),
      afterNotInvokedCommit: () => {
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error('native post-commit ambiguity');
        }
      },
      beforeNotInvokedReadback: () => {
        if (throwReadback) {
          throwReadback = false;
          throw new Error('transient readback unavailable');
        }
      },
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'definitely-not-invoked' as const,
        error: 'adapter unavailable before invocation',
      })
      .mockResolvedValueOnce({ kind: 'completed' as const, output: 'retry ok' })
      .mockResolvedValueOnce({
        kind: 'completed' as const,
        output: 'next manual run ok',
      });
    const retrying = new BuiltinScheduler({ ledger, turnAdapter: { invoke } });
    try {
      await retrying.addJob({
        name: 'retry-not-invoked-readback',
        prompt: 'go',
        retryCount: 1,
      });

      await expect(
        retrying.runJob('retry-not-invoked-readback'),
      ).resolves.toMatchObject({ outcome: 'completed' });
      expect(invoke).toHaveBeenCalledTimes(2);
      await expect(
        retrying.runJob('retry-not-invoked-readback'),
      ).resolves.toMatchObject({ outcome: 'completed' });
      expect(invoke).toHaveBeenCalledTimes(3);
    } finally {
      await retrying.stop();
    }
  });

  test('retains a definitely-not-invoked capability through repeated real SQLite lock failures without reinvoking attempt one', async () => {
    const directory = join(tempDir, 'retry-not-invoked-sqlite-lock');
    let unavailableTransitions = 0;
    const ledger = createSchedulerLedger({
      directory,
      busyTimeoutMs: 10,
      onNotInvokedUnavailable: () => {
        unavailableTransitions += 1;
      },
    });
    let child: ReturnType<typeof spawn> | undefined;
    let childExited = false;
    let childExit: Promise<unknown> | undefined;
    const lockProgram = `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => {
        database.exec('COMMIT');
        database.close();
        console.log('released');
        process.exit(0);
      }, 160);
    `;
    const invoke = vi.fn(async () => {
      if (child) return { kind: 'completed' as const, output: 'retry ok' };
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          lockProgram,
          join(directory, 'scheduler.sqlite'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      childExit = once(child, 'exit');
      const [locked] = (await once(child.stdout!, 'data')) as [Buffer];
      expect(locked.toString()).toContain('locked');
      return {
        kind: 'definitely-not-invoked' as const,
        error: 'adapter unavailable before invocation',
      };
    });
    const retrying = new BuiltinScheduler({ ledger, turnAdapter: { invoke } });
    try {
      await retrying.addJob({
        name: 'retry-not-invoked-sqlite-lock',
        prompt: 'go',
        retryCount: 1,
        // The durable transition may recover only after the writer releases
        // its lock. That recovered attempt must still honour the job backoff
        // before it can invoke the adapter.
        retryDelaySecs: 0.25,
      });
      const running = retrying.runJob('retry-not-invoked-sqlite-lock');
      await vi.waitFor(() => expect(childExit).toBeDefined());
      await childExit!;
      childExited = true;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(invoke).toHaveBeenCalledOnce();

      const result = await running;
      expect(result).toMatchObject({ outcome: 'completed' });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(unavailableTransitions).toBeGreaterThan(2);
      const logs = await retrying.getJobLogs('retry-not-invoked-sqlite-lock');
      expect(logs.map((log) => log.attempt)).toEqual([1, 2]);
    } finally {
      await retrying.stop();
      if (!childExited && child?.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  test('applies configured backoff after exact transition recovery and preserves the advanced retry when stopped', async () => {
    const directory = join(tempDir, 'recovered-not-invoked-backoff');
    let throwAfterCommit = true;
    let throwReadback = true;
    let unavailableTransitions = 0;
    const ledger = createSchedulerLedger({
      directory,
      afterNotInvokedCommit: () => {
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error('post-commit ambiguity');
        }
      },
      beforeNotInvokedReadback: () => {
        if (throwReadback) {
          throwReadback = false;
          throw new Error('first readback unavailable');
        }
      },
      onNotInvokedUnavailable: () => {
        unavailableTransitions += 1;
      },
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'definitely-not-invoked' as const,
        error: 'adapter unavailable before invocation',
      })
      .mockResolvedValueOnce({ kind: 'completed' as const, output: 'late' });
    const scheduler = new BuiltinScheduler({ ledger, turnAdapter: { invoke } });
    let replacement: ReturnType<typeof createSchedulerLedger> | undefined;
    try {
      await scheduler.addJob({
        name: 'recovered-not-invoked-backoff',
        prompt: 'go',
        retryCount: 1,
        retryDelaySecs: 0.5,
      });
      const running = scheduler.runJob('recovered-not-invoked-backoff');
      await vi.waitFor(() => expect(unavailableTransitions).toBeGreaterThan(0));
      // The same handle recovers attempt two after the short ambiguity retry,
      // but that recovery must not invoke it before its configured backoff.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(invoke).toHaveBeenCalledOnce();

      const [receipt] = await Promise.all([running, scheduler.stop()]);
      expect(receipt).toMatchObject({
        outcome: 'indeterminate',
        runId: expect.stringMatching(/-2$/),
      });
      expect(invoke).toHaveBeenCalledOnce();

      replacement = createSchedulerLedger({ directory });
      const resumed = replacement.claimManual(
        'recovered-not-invoked-backoff',
        Date.now(),
      );
      expect(resumed).toMatchObject({
        kind: 'claimed',
        receipt: {
          attempt: 2,
          id: receipt.runId
            .replace('schedule:built-in:recovered-not-invoked-backoff:', '')
            .replace(/-2$/, ''),
        },
      });
    } finally {
      replacement?.close();
      await scheduler.stop();
    }
  });

  test('stop aborts a retained unavailable transition without a detached retry and restart reconciles it conservatively', async () => {
    const directory = join(tempDir, 'stop-retained-not-invoked');
    let markStalled: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      markStalled = resolve;
    });
    let unavailableTransitions = 0;
    const ledger = createSchedulerLedger({
      directory,
      busyTimeoutMs: 10,
      onNotInvokedUnavailable: () => {
        unavailableTransitions += 1;
        if (unavailableTransitions >= 3) markStalled?.();
      },
    });
    let child: ReturnType<typeof spawn> | undefined;
    let childExited = false;
    const invoke = vi.fn(async () => {
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import { DatabaseSync } from 'node:sqlite';
            const database = new DatabaseSync(process.argv[1]);
            database.exec('BEGIN IMMEDIATE');
            console.log('locked');
            setInterval(() => undefined, 1000);
          `,
          join(directory, 'scheduler.sqlite'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      await once(child.stdout!, 'data');
      return {
        kind: 'definitely-not-invoked' as const,
        error: 'adapter unavailable before invocation',
      };
    });
    const scheduler = new BuiltinScheduler({ ledger, turnAdapter: { invoke } });
    let replacement: ReturnType<typeof createSchedulerLedger> | undefined;
    try {
      await scheduler.addJob({
        name: 'stop-retained-not-invoked',
        prompt: 'go',
        retryCount: 1,
      });
      const run = scheduler.runJob('stop-retained-not-invoked');
      await stalled;

      const [receipt] = await Promise.all([run, scheduler.stop()]);
      expect(receipt).toMatchObject({ outcome: 'indeterminate' });
      expect(invoke).toHaveBeenCalledOnce();

      child!.kill('SIGKILL');
      await once(child!, 'exit');
      childExited = true;
      replacement = createSchedulerLedger({ directory });
      expect(
        replacement.claimManual('stop-retained-not-invoked', Date.now()),
      ).toEqual(expect.objectContaining({ kind: 'claimed' }));
      expect(replacement.allLogs()).toEqual({
        kind: 'available',
        value: expect.arrayContaining([
          expect.objectContaining({ state: 'indeterminate', attempt: 1 }),
        ]),
      });
    } finally {
      replacement?.close();
      await scheduler.stop();
      if (!childExited && child?.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  test('stop closes its ledger exactly once so a same-process replacement can claim safely', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'scheduler-stop-replacement-'),
    );
    const ledger = createSchedulerLedger({ directory });
    const close = vi.spyOn(ledger, 'close');
    const owned = new BuiltinScheduler({
      ledger,
      turnAdapter: {
        invoke: vi.fn().mockResolvedValue({ kind: 'completed', output: 'ok' }),
      },
    });
    try {
      await owned.addJob({ name: 'replacement-safe', prompt: 'run' });
      await owned.stop();
      await owned.stop();
      expect(close).toHaveBeenCalledOnce();
      expect(() => owned.start()).toThrow(
        'Scheduler has been stopped and cannot be restarted',
      );

      const replacement = createSchedulerLedger({ directory });
      expect(replacement.claimManual('replacement-safe', Date.now()).kind).toBe(
        'claimed',
      );
      replacement.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('getStats reflects runs after execution', async () => {
    chatFnBehavior = { ok: true, text: 'ok' };
    await scheduler.addJob({ name: 'stats-job', prompt: 'test' });
    await scheduler.runJob('stats-job');
    await new Promise((r) => setTimeout(r, 50));
    const stats = await scheduler.getStats();
    const jobStats = stats.jobs.find((j) => j.name === 'stats-job');
    expect(jobStats?.total).toBe(1);
    expect(jobStats?.successes).toBe(1);
    expect(jobStats?.success_rate).toBe(100);
  });
});

// ── BuiltinScheduler job-run logger.child correlation (archive#1897) ──

describe('BuiltinScheduler — job-run logger correlation', () => {
  let logDir: string;
  let loggedScheduler: InstanceType<typeof BuiltinScheduler>;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'scheduler-correlation-test-'));
    installServerLogSink({ directory: logDir });
    const realLogger = createLogger({
      name: 'scheduler-correlation-test',
      level: 'info',
    });
    loggedScheduler = createBuiltin({ logger: realLogger });
  });

  afterEach(async () => {
    await loggedScheduler.stop();
    resetServerLogSinkForTests();
    rmSync(logDir, { recursive: true, force: true });
  });

  test('a successful job run is retrievable via ServerLogReader keyed on its own jobRunId, with jobName/jobRunId bindings intact', async () => {
    chatFnBehavior = { ok: true, text: 'ok' };
    const events: any[] = [];
    loggedScheduler.subscribe((d) => events.push(JSON.parse(d)));
    await loggedScheduler.addJob({ name: 'corr-success', prompt: 'go' });
    await loggedScheduler.runJob('corr-success');
    await new Promise((r) => setTimeout(r, 50));

    const started = events.find(
      (e) => e.event === 'job.started' && e.job === 'corr-success',
    );
    expect(started?.id).toBeTruthy();
    const jobRunId = started.id as string;

    const reader = createServerLogReader({ directory: logDir });
    const result = await reader.query({ q: jobRunId });
    expect(result.entries.length).toBeGreaterThanOrEqual(2); // started + completed
    for (const entry of result.entries) {
      expect(entry[SCHEDULER_LOG_BINDING_KEYS.JOB_NAME]).toBe('corr-success');
      expect(entry[SCHEDULER_LOG_BINDING_KEYS.JOB_RUN_ID]).toBe(jobRunId);
    }
    expect(result.entries.some((e) => e.msg === 'Scheduler job started')).toBe(
      true,
    );
    expect(
      result.entries.some((e) => e.msg === 'Scheduler job completed'),
    ).toBe(true);
  });

  test('a failed job run logs a warning carrying the same jobRunId binding', async () => {
    chatFnBehavior = { ok: false, text: '' };
    const events: any[] = [];
    loggedScheduler.subscribe((d) => events.push(JSON.parse(d)));
    await loggedScheduler.addJob({ name: 'corr-fail', prompt: 'break' });
    await loggedScheduler.runJob('corr-fail');
    await new Promise((r) => setTimeout(r, 50));

    const started = events.find(
      (e) => e.event === 'job.started' && e.job === 'corr-fail',
    );
    const jobRunId = started.id as string;

    const reader = createServerLogReader({ directory: logDir });
    const result = await reader.query({ q: jobRunId, level: 'warn' });
    expect(result.entries.some((e) => e.msg === 'Scheduler job failed')).toBe(
      true,
    );
    expect(
      result.entries.every(
        (e) => e[SCHEDULER_LOG_BINDING_KEYS.JOB_RUN_ID] === jobRunId,
      ),
    ).toBe(true);
  });

  test('BuiltinScheduler constructed without a logger (existing behavior) executes jobs with zero change', async () => {
    const bare = createBuiltin();
    chatFnBehavior = { ok: true, text: 'still works' };
    await bare.addJob({ name: 'no-logger-job', prompt: 'go' });
    await bare.runJob('no-logger-job');
    await new Promise((r) => setTimeout(r, 50));
    const logs = await bare.getJobLogs('no-logger-job');
    expect(logs[0]?.success).toBe(true);
    await bare.stop();
  });
});

// ── SchedulerService ──

describe('SchedulerService', () => {
  let service: InstanceType<typeof SchedulerService>;

  beforeEach(() => {
    service = createSchedulerService();
  });

  afterEach(() => {
    // Stop the builtin scheduler's timer
    (service as any).builtin.stop();
  });

  test('listProviders includes built-in', () => {
    const providers = service.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers.find((p) => p.id === 'built-in')).toBeDefined();
  });

  test('addJob and listJobs round-trip', async () => {
    await service.addJob({ name: 'svc-job', prompt: 'hello' });
    const jobs = await service.listJobs();
    expect(jobs.some((j) => j.name === 'svc-job')).toBe(true);
  });

  test('editJob routes to correct provider', async () => {
    await service.addJob({ name: 'svc-edit', prompt: 'original' });
    await service.editJob('svc-edit', { prompt: 'changed' });
    const jobs = await service.listJobs();
    expect(jobs.find((j) => j.name === 'svc-edit')?.prompt).toBe('changed');
  });

  test('removeJob routes to correct provider', async () => {
    await service.addJob({ name: 'svc-rm', prompt: 'bye' });
    await service.removeJob('svc-rm');
    const jobs = await service.listJobs();
    expect(jobs.some((j) => j.name === 'svc-rm')).toBe(false);
  });

  test('removeJob throws for unknown job', async () => {
    await expect(service.removeJob('ghost')).rejects.toThrow();
  });

  test('keeps a deleted job receipt attributable through list, detail, and output reads', async () => {
    chatFnBehavior = { ok: true, text: 'historical scheduler output' };
    await service.addJob({ name: 'deleted-history', prompt: 'run' });
    await service.runJob('deleted-history');
    const log = (await service.getJobLogs('deleted-history'))[0]!;
    await service.removeJob('deleted-history');

    const runs = await service.listRunSummaries({ providerId: 'built-in' });
    const listed = runs.find((run) => run.metadata?.legacyLogId === log.id);
    expect(listed).toMatchObject({
      sourceId: 'deleted-history',
      metadata: { jobId: log.jobId },
    });
    const detail = await service.readRunSummary(listed!.runId);
    expect(detail).toMatchObject({
      runId: listed!.runId,
      sourceId: 'deleted-history',
    });
    expect(await service.readOutputRef(detail!.outputRef!)).toBe(
      'historical scheduler output',
    );
  });

  test('manual receipts correlate exactly to RunService detail for confirmed and indeterminate executions', async () => {
    chatFnBehavior = { ok: true, text: 'confirmed output' };
    await service.addJob({ name: 'manual-run-correlation', prompt: 'run' });
    const completed = await service.runJob('manual-run-correlation');
    if ('output' in completed)
      throw new Error('built-in scheduler must return an observable receipt');
    const completedRun = await service.readRunSummary(completed.runId);
    expect(completedRun).toMatchObject({
      runId: completed.runId,
      status: 'completed',
      sourceId: 'manual-run-correlation',
    });

    chatFnBehavior = { ok: false, text: '' };
    const indeterminate = await service.runJob('manual-run-correlation');
    if ('output' in indeterminate)
      throw new Error('built-in scheduler must return an observable receipt');
    const indeterminateRun = await service.readRunSummary(indeterminate.runId);
    expect(indeterminate).toMatchObject({ outcome: 'indeterminate' });
    expect(indeterminateRun).toMatchObject({
      runId: indeterminate.runId,
      status: 'failed',
      failureKind: 'unknown',
      metadata: { schedulerState: 'indeterminate' },
    });
  });

  test('getStats returns successRate 0 when no runs', async () => {
    const stats = await service.getStats();
    expect(stats.summary.successRate).toBe(0);
  });

  test('getStatus includes built-in provider', async () => {
    const status = await service.getStatus();
    expect(status.providers['built-in']).toBeDefined();
    expect(status.providers['built-in'].running).toBe(true);
  });

  test('previewSchedule returns ISO strings', async () => {
    const previews = await service.previewSchedule('0 12 * * *', 3);
    expect(previews).toHaveLength(3);
    previews.forEach((p) => expect(p).toMatch(/^\d{4}-\d{2}-\d{2}T/));
  });

  test('addProvider registers a custom provider', async () => {
    const mock: any = {
      id: 'mock-provider',
      displayName: 'Mock',
      capabilities: [],
      listJobs: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({ jobs: [] }),
      getStatus: vi.fn().mockResolvedValue({ running: true, jobCount: 0 }),
    };
    service.addProvider(mock);
    const providers = service.listProviders();
    expect(providers.find((p) => p.id === 'mock-provider')).toBeDefined();
  });

  test('preserves authoritative completed and indeterminate provider outcomes when metrics throw', async () => {
    const provider: any = {
      id: 'metric-provider',
      displayName: 'Metric provider',
      capabilities: [],
      listJobs: vi.fn().mockResolvedValue([{ name: 'metric-job' }]),
      getStats: vi.fn().mockResolvedValue({ jobs: [] }),
      getStatus: vi.fn().mockResolvedValue({ running: true, jobCount: 1 }),
      runJob: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'completed',
          message: 'completed by provider',
          runId: 'schedule:metric:metric-job:run-1',
        })
        .mockResolvedValueOnce({
          outcome: 'indeterminate',
          message: 'provider may have started',
          runId: 'schedule:metric:metric-job:run-2',
        }),
    };
    service.addProvider(provider);
    vi.spyOn(schedulerJobRuns, 'add').mockImplementation(() => {
      throw new Error('metrics unavailable');
    });
    vi.spyOn(schedulerJobDuration, 'record').mockImplementation(() => {
      throw new Error('metrics unavailable');
    });

    await expect(service.runJob('metric-job')).resolves.toMatchObject({
      outcome: 'completed',
      runId: 'schedule:metric:metric-job:run-1',
    });
    await expect(service.runJob('metric-job')).resolves.toMatchObject({
      outcome: 'indeterminate',
      runId: 'schedule:metric:metric-job:run-2',
    });
  });
});

// ── Route Handlers ──

describe('Scheduler Routes', () => {
  let service: InstanceType<typeof SchedulerService>;
  let app: ReturnType<typeof createSchedulerRoutes>;

  beforeEach(() => {
    service = createSchedulerService();
    app = createSchedulerRoutes(service, mockLogger);
  });

  afterEach(() => {
    (service as any).builtin.stop();
  });

  test('GET /providers returns provider list', async () => {
    const res = await app.request('/providers');
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.some((p: any) => p.id === 'built-in')).toBe(true);
  });

  test('POST /jobs creates a job', async () => {
    const res = await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'route-job',
        prompt: 'test',
        cron: '0 * * * *',
      }),
    });
    const body = await json(res);
    expect(body.success).toBe(true);
  });

  test('GET /jobs lists jobs', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'list-me', prompt: 'test' }),
    });
    const res = await app.request('/jobs');
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.some((j: any) => j.name === 'list-me')).toBe(true);
  });

  test('PUT /jobs/:target edits a job', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'edit-route', prompt: 'original' }),
    });
    const res = await app.request('/jobs/edit-route', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'updated' }),
    });
    expect((await json(res)).success).toBe(true);
  });

  test('DELETE /jobs/:target removes a job', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'del-route', prompt: 'bye' }),
    });
    const res = await app.request('/jobs/del-route', { method: 'DELETE' });
    expect((await json(res)).success).toBe(true);
  });

  test('DELETE /jobs/:target returns 500 for missing job', async () => {
    const res = await app.request('/jobs/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect((await json(res)).success).toBe(false);
  });

  test('PUT /jobs/:target/enable enables a job', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'enable-me', prompt: 'test' }),
    });
    const res = await app.request('/jobs/enable-me/enable', { method: 'PUT' });
    expect((await json(res)).success).toBe(true);
  });

  test('PUT /jobs/:target/disable disables a job', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'disable-me', prompt: 'test' }),
    });
    const res = await app.request('/jobs/disable-me/disable', {
      method: 'PUT',
    });
    expect((await json(res)).success).toBe(true);
  });

  test('GET /stats returns stats', async () => {
    const res = await app.request('/stats');
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.summary.successRate).toBe(0);
  });

  test('GET /status returns status', async () => {
    const res = await app.request('/status');
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.providers['built-in']).toBeDefined();
  });

  test('GET /jobs/preview-schedule returns times', async () => {
    const res = await app.request(
      '/jobs/preview-schedule?cron=0+*+*+*+*&count=3',
    );
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
  });

  test('GET /jobs/preview-schedule requires cron param', async () => {
    const res = await app.request('/jobs/preview-schedule');
    expect(res.status).toBe(400);
  });

  test('GET /jobs/:target/logs returns logs', async () => {
    await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'log-job', prompt: 'test' }),
    });
    const res = await app.request('/jobs/log-job/logs');
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST /webhook broadcasts event', async () => {
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'job.completed', job: 'test' }),
    });
    expect((await json(res)).success).toBe(true);
  });

  test('POST /jobs/:target/run returns 500 for missing job', async () => {
    const res = await app.request('/jobs/ghost/run', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  test('routes an internally composed legacy provider output without inventing a receipt', async () => {
    service.addProvider({
      id: 'legacy-scheduler',
      displayName: 'Legacy scheduler',
      capabilities: [],
      listJobs: async () => [
        {
          name: 'legacy-job',
          prompt: 'run',
          provider: 'legacy-scheduler',
          enabled: true,
        },
      ],
      addJob: async () => 'unused',
      editJob: async () => 'unused',
      removeJob: async () => undefined,
      runJob: async () => 'legacy provider completed',
      enableJob: async () => undefined,
      disableJob: async () => undefined,
      getJobLogs: async () => [],
      getStats: async () => ({ jobs: [] }),
      getStatus: async () => ({ running: true, jobCount: 1 }),
    });

    const response = await app.request('/jobs/legacy-job/run', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({
      success: true,
      data: { output: 'legacy provider completed' },
    });
  });
});
