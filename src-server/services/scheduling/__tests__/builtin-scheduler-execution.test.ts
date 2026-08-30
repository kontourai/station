import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NotificationService } from '../../notifications/notification-service.js';
import { EventBus } from '../../orchestration/event-bus.js';
import {
  announceSchedulerJobFailure,
  executeSchedulerJobAttempt,
  resetAnnouncedSchedulerFailuresForTests,
} from '../builtin-scheduler-execution.js';
import type { SchedulerDispatchReceipt } from '../scheduler-ledger.js';

const tempDir =
  process.env.STATION_HOME ||
  join('/tmp', `scheduler-execution-test-${process.pid}`);

function receipt(
  path: string,
  overrides: Partial<SchedulerDispatchReceipt> = {},
): SchedulerDispatchReceipt {
  return {
    id: '0f0f0f0f-0000-4000-8000-000000000001',
    jobId: 'server-issued-job-id',
    job: Object.freeze({
      name: 'test',
      prompt: 'run',
      enabled: true,
      createdAt: new Date().toISOString(),
    }),
    startedAt: new Date().toISOString(),
    manual: false,
    missedCount: 0,
    attempt: 1,
    maxAttempts: 1,
    outputPath: () => path,
    releaseDeferred: () => ({ kind: 'applied' }),
    beginInvocation: () => ({ kind: 'applied' }),
    recordNotInvoked: () => ({ kind: 'terminal' }),
    settle: () => ({ kind: 'applied' }),
    ...overrides,
  };
}

describe('executeSchedulerJobAttempt', () => {
  // Announcements dedupe by run id for the life of the process; a test corpus
  // is one process and reuses ids that production never would.
  beforeEach(() => {
    resetAnnouncedSchedulerFailuresForTests();
  });

  afterEach(() => {
    rmSync(join(tempDir, 'scheduler'), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('records a successful run and completion broadcast', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const broadcast = vi.fn();
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'success-job',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'success-job-1',
      manual: true,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'success.log')),
      turnAdapter: {
        invoke: vi.fn().mockResolvedValue({ kind: 'completed', output: 'ok' }),
      },
      notificationService: null,
      broadcast,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(result.outputPath!, 'utf-8')).toBe('ok');
    expect(
      broadcast.mock.calls.some(
        ([event]) =>
          event.event === 'job.completed' && event.job === 'success-job',
      ),
    ).toBe(true);
  });

  test('invokes a scheduled job despite a synthetic 99%-busy diagnostic', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const invoke = vi.fn().mockResolvedValue({
      kind: 'completed',
      output: 'ran under load',
    });
    const releaseDeferred = vi.fn().mockReturnValue({ kind: 'applied' });
    const broadcast = vi.fn();
    const deps = {
      job: {
        name: 'degraded-job',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'degraded-job-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'degraded.log'), {
        releaseDeferred,
      }),
      turnAdapter: { invoke },
      notificationService: null,
      broadcast,
      // Deliberately supplied as an excess legacy property: execution must
      // neither sample nor branch on this diagnostic.
      resourcePosture: {
        observe: async () => ({
          kind: 'critical',
          busyPercent: 99,
          cpuCount: 8,
          sampledAt: 100,
          sampleMs: 500,
          thresholdPercent: 85,
          source: 'test',
        }),
      },
    };
    const result = await executeSchedulerJobAttempt(deps);

    expect(result).toMatchObject({ outcome: 'completed', success: true });
    expect(releaseDeferred).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job.completed',
        job: 'degraded-job',
      }),
    );
    expect(
      broadcast.mock.calls.some(([event]) => event.event === 'job.failed'),
    ).toBe(false);
  });

  test('records a failed run and schedules notification when not retrying', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const notificationService = {
      schedule: vi.fn().mockResolvedValue(undefined),
      dispatch: vi.fn((_operation: string, task: () => Promise<unknown>) => {
        task().catch(() => undefined);
      }),
    };
    const broadcast = vi.fn();
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'failure-job',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'failure-job-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'failure.log')),
      turnAdapter: {
        invoke: vi
          .fn()
          .mockResolvedValue({ kind: 'indeterminate', error: 'boom' }),
      },
      notificationService: notificationService as any,
      broadcast,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(readFileSync(result.outputPath!, 'utf-8')).toBe('boom');
    expect(
      broadcast.mock.calls.some(
        ([event]) =>
          event.event === 'job.failed' && event.job === 'failure-job',
      ),
    ).toBe(true);
    expect(notificationService.schedule).toHaveBeenCalledOnce();
  });

  test('settles indeterminate when output persistence fails after provider completion, without retrying the artifact write', async () => {
    const settle = vi.fn().mockReturnValue({ kind: 'applied' });
    const output = join(tempDir, 'missing', 'output.log');
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'output-fault',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'output-fault-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(output, { settle }),
      turnAdapter: {
        invoke: vi
          .fn()
          .mockResolvedValue({ kind: 'completed', output: 'done' }),
      },
      notificationService: null,
      broadcast: vi.fn(() => {
        throw new Error('observer must not run before settlement');
      }),
    });

    expect(result).toMatchObject({ outcome: 'indeterminate', success: false });
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, terminal: true }),
    );
  });

  test('isolates post-settlement observer failures from the receipt outcome', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const settle = vi.fn().mockReturnValue({ kind: 'applied' });
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'observer-fault',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'observer-fault-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'observer.log'), {
        settle,
      }),
      turnAdapter: {
        invoke: vi
          .fn()
          .mockResolvedValue({ kind: 'completed', output: 'done' }),
      },
      notificationService: null,
      broadcast: vi.fn(() => {
        throw new Error('SSE down');
      }),
      logger: {
        info: vi.fn(() => {
          throw new Error('logger down');
        }),
        warn: vi.fn(),
      },
    });
    expect(result).toMatchObject({ outcome: 'completed', success: true });
    expect(settle).toHaveBeenCalledOnce();
  });

  test('bounds an abort-ignoring Adapter, persists indeterminate once, and ignores a late success', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    let resolveLate!: (value: { kind: 'completed'; output: string }) => void;
    const late = new Promise<{ kind: 'completed'; output: string }>(
      (resolve) => {
        resolveLate = resolve;
      },
    );
    const settle = vi.fn().mockReturnValue({ kind: 'applied' });
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'hung',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'hung-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'hung.log'), {
        settle,
      }),
      turnAdapter: { invoke: vi.fn().mockImplementation(() => late) },
      notificationService: null,
      broadcast: vi.fn(),
      timeoutMs: 0,
    });
    expect(result).toMatchObject({ outcome: 'indeterminate', success: false });
    expect(settle).toHaveBeenCalledOnce();
    resolveLate({ kind: 'completed', output: 'too late' });
    await Promise.resolve();
    expect(settle).toHaveBeenCalledOnce();
  });

  test('forwards scheduler shutdown cancellation and settles an abort-ignoring invocation boundedly', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const shutdown = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveLate!: (value: { kind: 'completed'; output: string }) => void;
    const late = new Promise<{ kind: 'completed'; output: string }>(
      (resolve) => {
        resolveLate = resolve;
      },
    );
    const settle = vi.fn().mockReturnValue({ kind: 'applied' });
    const running = executeSchedulerJobAttempt({
      job: {
        name: 'shutdown',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'shutdown-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'shutdown.log'), {
        settle,
      }),
      turnAdapter: {
        invoke: vi.fn(({ signal }) => {
          seenSignal = signal;
          return late;
        }),
      },
      notificationService: null,
      broadcast: vi.fn(),
      signal: shutdown.signal,
    });
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    shutdown.abort(new Error('stop'));
    await expect(running).resolves.toMatchObject({ outcome: 'indeterminate' });
    expect(seenSignal!.aborted).toBe(true);
    expect(settle).toHaveBeenCalledOnce();
    resolveLate({ kind: 'completed', output: 'late' });
    await Promise.resolve();
    expect(settle).toHaveBeenCalledOnce();
  });

  test('terminalizes a definitely-not-invoked final attempt instead of leaving its claim busy', async () => {
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const recordNotInvoked = vi.fn().mockReturnValue({ kind: 'terminal' });
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'no-retry',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'no-retry-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'no-retry.log'), {
        recordNotInvoked,
      }),
      turnAdapter: {
        invoke: vi.fn().mockResolvedValue({
          kind: 'definitely-not-invoked',
          error: 'offline',
        }),
      },
      notificationService: null,
      broadcast: vi.fn(),
    });
    expect(result.outcome).toBe('not-invoked');
    expect(recordNotInvoked).toHaveBeenCalledOnce();
  });

  test('a run the engine never received records a specific reason and reaches the user like any other failure', async () => {
    // The reason and the notification were previously guaranteed only for an
    // invocation that THREW. A never-invoked run writes an identically
    // `failed` ledger entry, so the Schedule page shows a Failed row either
    // way — this path has to explain it and announce it too.
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const recordNotInvoked = vi.fn().mockReturnValue({ kind: 'terminal' });
    const broadcast = vi.fn();
    const schedule = vi.fn();
    const result = await executeSchedulerJobAttempt({
      job: {
        name: 'never-invoked',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'never-invoked-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(
        join(tempDir, 'scheduler', 'logs', 'never-invoked.log'),
        { recordNotInvoked },
      ),
      turnAdapter: {
        invoke: vi.fn().mockResolvedValue({
          kind: 'definitely-not-invoked',
          error: 'engine connection is disabled',
        }),
      },
      notificationService: {
        dispatch: (_name: string, effect: () => unknown) => effect(),
        schedule,
      } as never,
      broadcast,
    });

    const reason = 'Engine never invoked: engine connection is disabled';
    // The reason is what the ledger stores, so it is what the run row renders.
    expect(recordNotInvoked).toHaveBeenCalledWith(
      expect.objectContaining({ error: reason }),
    );
    expect(result.error).toBe(reason);
    expect(
      broadcast.mock.calls.some(
        ([event]) =>
          event.event === 'job.failed' &&
          event.job === 'never-invoked' &&
          event.error === reason,
      ),
    ).toBe(true);
    expect(schedule).toHaveBeenCalledWith(
      'scheduler',
      expect.objectContaining({
        category: 'job-failure',
        title: 'Job "never-invoked" failed',
        body: reason,
      }),
    );
  });

  test('one run is announced once even when two callers discover the same failure', () => {
    // Two code paths can find the same failed run: the execution path when its
    // transition lands, and the scheduler's recovery loop when a RETAINED
    // transition lands later. Neither can see what the other did. They are
    // structurally exclusive today — which is exactly why this rejection path
    // needs its own test rather than relying on a scheduler-level assertion
    // that would pass whether or not the guard exists.
    const broadcast = vi.fn();
    const schedule = vi.fn();
    const notificationService = {
      dispatch: (_name: string, effect: () => unknown) => effect(),
      schedule,
    } as never;
    const announcement = {
      job: 'twice-discovered',
      id: '0f0f0f0f-0000-4000-8000-000000000042-1',
      error: 'Engine never invoked: adapter unavailable before invocation',
      broadcast,
      notificationService,
    };

    announceSchedulerJobFailure(announcement);
    announceSchedulerJobFailure(announcement);

    expect(
      broadcast.mock.calls.filter(([event]) => event.event === 'job.failed'),
    ).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  /**
   * The announcement's durable contract, exercised through the seams a
   * production failure actually crosses: a claim over the run's row, and a
   * notification write that has to LAND before the row may say it did.
   */
  function announcementHarness(
    options: {
      claim?: (
        id: string,
      ) => 'claimed' | 'already-announced' | 'leased-elsewhere' | 'unknown';
      admit?: boolean;
      persist?: () => Promise<unknown>;
    } = {},
  ) {
    const broadcast = vi.fn();
    const schedule = vi.fn(options.persist ?? (async () => ({})));
    const markAnnounced = vi.fn();
    const releaseAnnouncement = vi.fn();
    const notificationService = {
      // The real service admits a task to an async queue and runs it later;
      // `dispatch` answering true says nothing about the write landing.
      dispatch: (_name: string, task: () => Promise<unknown>) => {
        if (options.admit === false) return false;
        void task().catch(() => undefined);
        return true;
      },
      schedule,
    } as never;
    return {
      broadcast,
      schedule,
      markAnnounced,
      releaseAnnouncement,
      notificationService,
      outbox: {
        claimAnnouncement: (id: string) => {
          const kind = options.claim?.(id) ?? 'claimed';
          return kind === 'claimed'
            ? ({ kind, token: `token-for-${id}` } as const)
            : ({ kind } as const);
        },
        releaseAnnouncement,
        markAnnounced,
      },
      failures: () =>
        broadcast.mock.calls.filter(([event]) => event.event === 'job.failed'),
    };
  }

  test('a run the durable outbox already recorded is not announced again, and a new one is stamped', async () => {
    // The in-process Set is a fast path, not the source of truth: it is
    // cleared by exactly the restart that discovers a crashed process's
    // failures. What must stop a second announcement is the run's own row.
    const h = announcementHarness({
      claim: (id) =>
        id === 'already-told-1' ? 'already-announced' : 'claimed',
    });

    await announceSchedulerJobFailure({
      job: 'outbox-governed',
      id: 'already-told-1',
      error: 'the user has seen this one',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.markAnnounced).not.toHaveBeenCalled();

    await announceSchedulerJobFailure({
      job: 'outbox-governed',
      id: 'still-owed-1',
      error: 'nobody has been told about this one',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });
    expect(h.failures()).toHaveLength(1);
    expect(h.schedule).toHaveBeenCalledTimes(1);
    // Stamped only after the notification write resolved.
    expect(h.markAnnounced).toHaveBeenCalledWith(
      'still-owed-1',
      'token-for-still-owed-1',
    );
  });

  test('a refused notification dispatch leaves the run owed instead of stamping it', async () => {
    // `dispatch` returns false during shutdown: nothing is queued and no
    // notification will ever exist. Stamping here would record a delivery
    // that never happened — the exact silent loss the outbox exists to stop.
    // The SSE broadcast is not a substitute: it is ephemeral and may have no
    // subscriber at all.
    const h = announcementHarness({ admit: false });

    await announceSchedulerJobFailure({
      job: 'refused-dispatch',
      id: 'refused-1',
      error: 'the queue was closed',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });

    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.markAnnounced).not.toHaveBeenCalled();
    expect(h.releaseAnnouncement).toHaveBeenCalledWith(
      'refused-1',
      'token-for-refused-1',
    );
  });

  test('a notification write that rejects leaves the run owed instead of stamping it', async () => {
    // Admitted to the queue, then the store write failed. Queue admission is
    // not persistence, and only persistence may close the announcement.
    const h = announcementHarness({
      persist: async () => {
        throw new Error('notification store write failed');
      },
    });

    await announceSchedulerJobFailure({
      job: 'rejected-write',
      id: 'rejected-1',
      error: 'disk said no',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });

    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.markAnnounced).not.toHaveBeenCalled();
    expect(h.releaseAnnouncement).toHaveBeenCalledWith(
      'rejected-1',
      'token-for-rejected-1',
    );
  });

  test('does not stamp before the notification write resolves', async () => {
    // The ordering claim itself: while the write is still in flight the run
    // is not yet announced, so a process that dies here leaves it owed.
    let settle: (() => void) | undefined;
    const h = announcementHarness({
      persist: () =>
        new Promise<unknown>((resolve) => {
          settle = () => resolve({});
        }),
    });

    const announcement = announceSchedulerJobFailure({
      job: 'ordering',
      id: 'in-flight-1',
      error: 'still writing',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });
    await Promise.resolve();
    expect(h.failures()).toHaveLength(1);
    expect(h.markAnnounced).not.toHaveBeenCalled();

    settle?.();
    await announcement;
    expect(h.markAnnounced).toHaveBeenCalledWith(
      'in-flight-1',
      'token-for-in-flight-1',
    );
  });

  test('a run another process is announcing right now is left to that claimant', async () => {
    // Two Stations over one home both sweep the same owed row. Only the
    // lease holder announces; the other must not duplicate the bell entry,
    // and must not remember the run as announced — if the holder dies, the
    // lease expires and this process may legitimately announce it later.
    const h = announcementHarness({ claim: () => 'leased-elsewhere' });

    await announceSchedulerJobFailure({
      job: 'contended',
      id: 'leased-1',
      error: 'somebody else is telling the user',
      broadcast: h.broadcast,
      notificationService: h.notificationService,
      outbox: h.outbox,
    });

    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.markAnnounced).not.toHaveBeenCalled();
    expect(h.releaseAnnouncement).not.toHaveBeenCalled();
  });

  /**
   * The dedupe branch that resolves successfully WITHOUT writing anything.
   *
   * These run against the real NotificationService and its real store,
   * because the defect they pin is invisible to a mock: `schedule()` returns
   * a Notification either way, and only the document on disk says whether a
   * bell entry for THIS failure exists.
   */
  function realNotifications(
    name: string,
    options: { beforeActionDispatch?: (id: string) => Promise<void> } = {},
  ) {
    const dir = join(tempDir, 'scheduler', 'notifications', name);
    mkdirSync(dir, { recursive: true });
    return new NotificationService(new EventBus(), dir, 999_999, options);
  }

  function outboxSpy() {
    const markAnnounced = vi.fn();
    const releaseAnnouncement = vi.fn();
    return {
      markAnnounced,
      releaseAnnouncement,
      outbox: {
        claimAnnouncement: (id: string) =>
          ({ kind: 'claimed', token: `token-for-${id}` }) as const,
        releaseAnnouncement,
        markAnnounced,
      },
    };
  }

  test('a later failure still reaches the bell after an earlier one was dismissed', async () => {
    // A dismissal is terminal for the notification it dismisses. Under a
    // job-scoped dedupe tag it was also terminal for every FUTURE failure of
    // that job: `schedule()` found the dismissed row, wrote nothing, resolved
    // successfully, and each later run was stamped announced with nothing in
    // the bell. One dismissal, and that job goes quiet forever.
    const notificationService = realNotifications('dismissed-prior');
    const spy = outboxSpy();
    const broadcast = vi.fn();

    await announceSchedulerJobFailure({
      job: 'flaky',
      id: 'run-a-1',
      error: 'first failure',
      broadcast,
      notificationService,
      outbox: spy.outbox,
    });
    const [first] = await notificationService.list();
    expect(first).toMatchObject({ status: 'delivered', body: 'first failure' });
    expect(await notificationService.dismiss(first!.id)).toBe('dismissed');

    await announceSchedulerJobFailure({
      job: 'flaky',
      id: 'run-b-1',
      error: 'second failure',
      broadcast,
      notificationService,
      outbox: spy.outbox,
    });

    const delivered = (await notificationService.list()).filter(
      (entry) => entry.status === 'delivered',
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ body: 'second failure' });
    // Stamped because a notification really was written for THIS run.
    expect(spy.markAnnounced).toHaveBeenCalledWith(
      'run-b-1',
      'token-for-run-b-1',
    );
    expect(spy.releaseAnnouncement).not.toHaveBeenCalled();
  });

  test('a later failure still reaches the bell while an earlier one holds an action lease', async () => {
    // The same no-write branch, reached the other way: a notification the
    // user is acting on is not replaced, so under a job-scoped tag the next
    // failure of that job wrote nothing and was stamped anyway.
    let leaseHeld: (id: string) => void = () => undefined;
    const held = new Promise<string>((resolve) => {
      leaseHeld = resolve;
    });
    const notificationService = realNotifications('action-leased-prior', {
      beforeActionDispatch: async (id: string) => {
        leaseHeld(id);
        // Holds the lease for the rest of the test, as a slow provider would.
        await new Promise(() => undefined);
      },
    });
    const spy = outboxSpy();
    const broadcast = vi.fn();

    await announceSchedulerJobFailure({
      job: 'leased',
      id: 'run-c-1',
      error: 'failure under action',
      broadcast,
      notificationService,
      outbox: spy.outbox,
    });
    const [existing] = await notificationService.list();
    void notificationService.action(existing!.id, 'view-logs');
    await held;

    await announceSchedulerJobFailure({
      job: 'leased',
      id: 'run-d-1',
      error: 'failure after the lease',
      broadcast,
      notificationService,
      outbox: spy.outbox,
    });

    const bodies = (await notificationService.list()).map(
      (entry) => entry.body,
    );
    expect(bodies).toContain('failure after the lease');
    expect(spy.markAnnounced).toHaveBeenCalledWith(
      'run-d-1',
      'token-for-run-d-1',
    );
  });

  test('a different run is still announced after one has been', () => {
    // The guard must suppress a repeat, not the next run.
    const broadcast = vi.fn();
    const base = {
      job: 'distinct-runs',
      error: 'Engine never invoked: adapter unavailable before invocation',
      broadcast,
      notificationService: null,
    };
    announceSchedulerJobFailure({ ...base, id: 'run-a-1' });
    announceSchedulerJobFailure({ ...base, id: 'run-a-2' });
    expect(
      broadcast.mock.calls.filter(([event]) => event.event === 'job.failed'),
    ).toHaveLength(2);
  });

  test('a never-invoked attempt whose ledger transition did not land announces nothing', async () => {
    // Nothing durable was written, so there is no run row to explain — and an
    // announcement here would be a failure notification for a run the user
    // cannot find anywhere.
    mkdirSync(join(tempDir, 'scheduler', 'logs'), { recursive: true });
    const broadcast = vi.fn();
    const schedule = vi.fn();
    await executeSchedulerJobAttempt({
      job: {
        name: 'stale-not-invoked',
        prompt: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      id: 'stale-not-invoked-1',
      manual: false,
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      receipt: receipt(join(tempDir, 'scheduler', 'logs', 'stale.log'), {
        recordNotInvoked: vi.fn().mockReturnValue({ kind: 'stale' }),
      }),
      turnAdapter: {
        invoke: vi.fn().mockResolvedValue({
          kind: 'definitely-not-invoked',
          error: 'engine connection is disabled',
        }),
      },
      notificationService: {
        dispatch: (_name: string, effect: () => unknown) => effect(),
        schedule,
      } as never,
      broadcast,
    });

    expect(
      broadcast.mock.calls.some(([event]) => event.event === 'job.failed'),
    ).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });
});
