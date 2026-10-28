/**
 * Automation rules the scheduler owns for a job with a `target`: fatigue
 * (disable after repeated failures, one bell, reset on success), the
 * lateness cutoff after Station was off, and the targets it refuses.
 *
 * Real `BuiltinScheduler` and SQLite `SchedulerLedger`; the conversation
 * runner is a scripted fake, because what is under test is what the
 * scheduler does with each outcome, not how a turn is placed (that is
 * `scheduled-conversation-run-dispatch.test.ts`).
 */
import { AUTOMATION_RUN_POLICY } from '@kontourai/station-contracts/scheduler';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import {
  readScheduledTurnTerminal,
  SCHEDULED_TURN_TERMINAL_METHODS,
  type ScheduledConversationRunInput,
  type ScheduledConversationRunOutcome,
} from '../scheduled-conversation-runs.js';
import {
  countConsecutiveFailures,
  createSchedulerLedger,
} from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();
const schedulers: BuiltinScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
});

const TARGET = { kind: 'conversation', conversationId: 'chat-1' } as const;
const CREATOR = { userId: 'human:local:operator' };

function harness() {
  const root = makeTempDir('station-automation-');
  const outcomes: ScheduledConversationRunOutcome['kind'][] = [];
  const runs: ScheduledConversationRunInput[] = [];
  const schedule = vi.fn().mockResolvedValue(undefined);
  const scheduler = new BuiltinScheduler({
    ledger: createSchedulerLedger({ directory: root }),
    turnAdapter: { invoke: vi.fn() },
    conversationRuns: {
      run: async (input) => {
        runs.push(input);
        const kind = outcomes.shift() ?? 'completed';
        return kind === 'completed'
          ? { kind, output: '{}', conversationId: 'chat-1' }
          : kind === 'failed'
            ? {
                kind,
                error: 'The run’s turn stopped.',
                conversationId: 'chat-1',
              }
            : { kind: 'indeterminate', error: 'unknown' };
      },
    },
    notificationService: {
      dispatch: (_operation: string, task: () => Promise<unknown>) => {
        void task().catch(() => undefined);
        return true;
      },
      schedule,
    } as never,
  });
  schedulers.push(scheduler);
  const fatigueBells = () =>
    schedule.mock.calls.filter(([, notification]) =>
      String(notification.dedupeTag).startsWith('scheduler:fatigue:'),
    );
  const job = async () => (await scheduler.listJobs())[0]!;
  return { root, scheduler, outcomes, runs, fatigueBells, job };
}

describe('fatigue', () => {
  const threshold = AUTOMATION_RUN_POLICY.fatigueFailureThreshold;

  test('pins the threshold the product states', () => {
    expect(threshold).toBe(5);
  });

  test(`${threshold} failures in a row disable the automation and ring exactly once; a success resets the count`, async () => {
    const { scheduler, outcomes, fatigueBells, job } = harness();
    await scheduler.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 60 * 60_000 },
      prompt: 'Summarize',
      target: TARGET,
      createdBy: CREATOR,
    });

    // One short of the threshold, then a success: the count resets.
    outcomes.push(...Array(threshold - 1).fill('failed'), 'completed');
    for (let run = 0; run < threshold; run += 1)
      await scheduler.runJob('digest');
    expect(await job()).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
      lastSuccessAt: expect.any(String),
    });
    expect(fatigueBells()).toHaveLength(0);

    // Indeterminate counts too: a run that may have happened did not succeed.
    outcomes.push(...Array(threshold - 1).fill('failed'), 'indeterminate');
    for (let run = 0; run < threshold - 1; run += 1)
      await scheduler.runJob('digest');
    expect(await job()).toMatchObject({
      enabled: true,
      consecutiveFailures: threshold - 1,
    });
    await scheduler.runJob('digest');
    expect(await job()).toMatchObject({
      enabled: false,
      consecutiveFailures: threshold,
    });
    await vi.waitFor(() => expect(fatigueBells()).toHaveLength(1));
    expect(fatigueBells()[0]![1]).toMatchObject({
      title: 'Automation "digest" turned off',
      metadata: { jobName: 'digest', link: '/automations?job=digest' },
    });

    // Another failure while it is off is not a second disable or bell.
    outcomes.push('failed');
    await scheduler.runJob('digest');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fatigueBells()).toHaveLength(1);
  });

  test('the derived count skips running receipts and late misses', () => {
    const base = {
      job: 'digest',
      startedAt: '2026-10-28T00:00:00.000Z',
    } as const;
    expect(
      countConsecutiveFailures([
        { ...base, id: 'a', success: true },
        { ...base, id: 'b', success: false, state: 'failed' },
        { ...base, id: 'c', success: false, state: 'failed', skipped: 'late' },
        { ...base, id: 'd', success: false, state: 'indeterminate' },
        { ...base, id: 'e', success: false, state: 'running' },
      ]),
    ).toBe(2);
  });
});

describe('lateness cutoff', () => {
  test('a targeted occurrence older than the cutoff is recorded missed, never run or announced', () => {
    const root = makeTempDir('station-automation-late-');
    const ledger = createSchedulerLedger({ directory: root });
    const created = Date.parse('2026-10-20T00:00:00.000Z');
    // Daily at 09:00 UTC; Station comes back at 20:00, eleven hours late.
    const now = Date.parse('2026-10-27T20:00:00.000Z');
    for (const [name, target] of [
      ['targeted', TARGET],
      ['legacy', undefined],
    ] as const)
      expect(
        ledger.create({
          name,
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          prompt: 'Summarize',
          enabled: true,
          createdAt: new Date(created).toISOString(),
          ...(target ? { target, createdBy: CREATOR } : {}),
        }),
      ).toEqual({ kind: 'created' });

    const claimed = ledger.claimDue(now);
    if (claimed.kind !== 'available') throw new Error('expected a claim read');
    // The legacy job keeps its run-latest-once behaviour; the targeted one
    // does not run eleven hours late.
    expect(claimed.value.map((receipt) => receipt.job.name)).toEqual([
      'legacy',
    ]);
    const logs = ledger.logs('targeted');
    if (logs.kind !== 'available') throw new Error('expected logs');
    expect(logs.value).toEqual([
      expect.objectContaining({
        skipped: 'late',
        success: false,
        scheduledFor: '2026-10-27T09:00:00.000Z',
      }),
    ]);
    const owed = ledger.owedFailureAnnouncements(now);
    if (owed.kind !== 'available') throw new Error('expected owed read');
    expect(owed.value.entries.map((entry) => entry.job)).not.toContain(
      'targeted',
    );
    // The cursor moved past it: the same instant claims nothing more.
    const again = ledger.claimDue(now);
    if (again.kind !== 'available') throw new Error('expected a claim read');
    expect(again.value.map((receipt) => receipt.job.name)).not.toContain(
      'targeted',
    );
  });

  test('an occurrence within the cutoff still runs', () => {
    const root = makeTempDir('station-automation-ontime-');
    const ledger = createSchedulerLedger({ directory: root });
    expect(
      ledger.create({
        name: 'targeted',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        prompt: 'Summarize',
        enabled: true,
        createdAt: '2026-10-20T00:00:00.000Z',
        target: TARGET,
        createdBy: CREATOR,
      }),
    ).toEqual({ kind: 'created' });
    const claimed = ledger.claimDue(Date.parse('2026-10-27T09:05:00.000Z'));
    if (claimed.kind !== 'available') throw new Error('expected a claim read');
    expect(claimed.value.map((receipt) => receipt.job.name)).toEqual([
      'targeted',
    ]);
  });
});

describe('targets the scheduler refuses', () => {
  test.each([
    [
      'a monitor',
      {
        monitor: {
          kind: 'github-pull-request' as const,
          objective: 'review-ready' as const,
          target: 'https://github.com/kontourai/station/pull/1',
          projectId: 'personal',
          agentId: 'station',
        },
      },
      /cannot have a monitor/,
    ],
    ['retries', { retryCount: 2 }, /cannot retry/],
    ['no recorded creator', { createdBy: undefined }, /recorded creator/],
  ])('a target with %s', async (_case, extra, message) => {
    const { scheduler } = harness();
    await expect(
      scheduler.addJob({
        name: 'refused',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'Summarize',
        target: TARGET,
        createdBy: CREATOR,
        ...extra,
      }),
    ).rejects.toThrow(message);
  });

  test('an edit cannot add retries to a targeted job', async () => {
    const { scheduler } = harness();
    await scheduler.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Summarize',
      target: TARGET,
      createdBy: CREATOR,
    });
    await expect(
      scheduler.editJob('digest', { retryCount: 1 }),
    ).rejects.toThrow(/cannot retry/);
  });

  test('a dedicated target’s conversation id is server-written, never accepted', async () => {
    const { scheduler, runs } = harness();
    await scheduler.addJob({
      name: 'own-chat',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Summarize',
      target: {
        kind: 'dedicated',
        agent: 'claude',
        conversationId: 'someone-elses-chat',
      },
      createdBy: CREATOR,
    });
    expect((await scheduler.listJobs())[0]!.target).toEqual({
      kind: 'dedicated',
      agent: 'claude',
    });
    await scheduler.runJob('own-chat');
    expect(runs[0]!.target).toEqual({ kind: 'dedicated', agent: 'claude' });
    // The runner reports the conversation it started; the job records it.
    runs[0]!.onConversationStarted('started-chat');
    expect((await scheduler.listJobs())[0]!.target).toEqual({
      kind: 'dedicated',
      agent: 'claude',
      conversationId: 'started-chat',
    });
  });

  test('without a runner, a targeted job fails without invoking anything', async () => {
    const root = makeTempDir('station-automation-hosted-');
    const invoke = vi.fn();
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke },
    });
    schedulers.push(scheduler);
    await scheduler.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Summarize',
      target: TARGET,
      createdBy: CREATOR,
    });
    await expect(scheduler.runJob('digest')).resolves.toMatchObject({
      outcome: 'failed',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

/** A notification service that delivers each scheduled bell at once. */
function deliveringNotifications() {
  const schedule = vi.fn().mockResolvedValue(undefined);
  return {
    schedule,
    service: {
      dispatch: (_operation: string, task: () => Promise<unknown>) => {
        void task().catch(() => undefined);
        return true;
      },
      schedule,
    } as never,
    fatigueBells: () =>
      schedule.mock.calls.filter(([, notification]) =>
        String(notification.dedupeTag).startsWith('scheduler:fatigue:'),
      ),
  };
}

/** Settle one manual failed run straight through a ledger, as a dying process would. */
function persistFailedRun(root: string, name: string) {
  const ledger = createSchedulerLedger({ directory: root });
  const claimed = ledger.claimManual(name, Date.now());
  if (claimed.kind !== 'claimed') throw new Error('claim failed');
  expect(claimed.receipt.beginInvocation()).toEqual({ kind: 'applied' });
  expect(
    claimed.receipt.settle({
      success: false,
      state: 'failed',
      completedAt: new Date().toISOString(),
      durationSecs: 0,
    }),
  ).toEqual({ kind: 'applied' });
  ledger.close();
}

describe('fix round: fatigue counts occurrences, survives crashes, resets on re-enable', () => {
  const threshold = AUTOMATION_RUN_POLICY.fatigueFailureThreshold;

  test('one occurrence with four pre-effect retries is one failed run, not five', async () => {
    const root = makeTempDir('station-automation-retries-');
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: {
        invoke: async () => ({
          kind: 'definitely-not-invoked' as const,
          error: 'provider unavailable',
        }),
      },
    });
    schedulers.push(scheduler);
    await scheduler.addJob({
      name: 'legacy',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'x',
      retryCount: 4,
      retryDelaySecs: 0,
    });
    await scheduler.runJob('legacy');
    expect(await scheduler.getJobLogs('legacy')).toHaveLength(5);
    expect((await scheduler.listJobs())[0]).toMatchObject({
      enabled: true,
      consecutiveFailures: 1,
    });
  });

  test('a restart after the fifth persisted failure disables the job and rings once', async () => {
    const root = makeTempDir('station-automation-crash-settle-');
    const first = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke: vi.fn() },
    });
    await first.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 86_400_000 },
      prompt: 'x',
      target: TARGET,
      createdBy: CREATOR,
    });
    await first.stop();
    // Five failures reach the ledger; the process that wrote them dies
    // before any fatigue step runs.
    for (let run = 0; run < threshold; run += 1)
      persistFailedRun(root, 'digest');
    const bells = deliveringNotifications();
    const restarted = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke: vi.fn() },
      notificationService: bells.service,
    });
    schedulers.push(restarted);
    restarted.start();
    await vi.waitFor(() => expect(bells.fatigueBells()).toHaveLength(1));
    expect((await restarted.listJobs())[0]).toMatchObject({
      enabled: false,
      consecutiveFailures: threshold,
    });
    // Another restart neither disables again nor rings again.
    await restarted.stop();
    schedulers.splice(schedulers.indexOf(restarted), 1);
    const again = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke: vi.fn() },
      notificationService: bells.service,
    });
    schedulers.push(again);
    again.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bells.fatigueBells()).toHaveLength(1);
  });

  test('a crash between the disable and its bell still rings once on the next start', async () => {
    const root = makeTempDir('station-automation-crash-bell-');
    const setup = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke: vi.fn() },
    });
    await setup.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 86_400_000 },
      prompt: 'x',
      target: TARGET,
      createdBy: CREATOR,
    });
    await setup.stop();
    for (let run = 0; run < threshold; run += 1)
      persistFailedRun(root, 'digest');
    // The disable and its owed bell commit; the process dies before ringing.
    const ledger = createSchedulerLedger({ directory: root });
    const applied = ledger.applyFatigue(threshold);
    if (applied.kind !== 'available') throw new Error('expected a transition');
    expect(applied.value).toHaveLength(1);
    ledger.close();
    const bells = deliveringNotifications();
    const restarted = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke: vi.fn() },
      notificationService: bells.service,
    });
    schedulers.push(restarted);
    restarted.start();
    await vi.waitFor(() => expect(bells.fatigueBells()).toHaveLength(1));
    expect(bells.fatigueBells()[0]![1]).toMatchObject({
      title: 'Automation "digest" turned off',
      metadata: { jobName: 'digest', link: '/automations?job=digest' },
    });
    expect((await restarted.listJobs())[0]).toMatchObject({ enabled: false });
  });

  test('turning a fatigue-disabled job back on resets its count', async () => {
    const { scheduler, outcomes, fatigueBells, job } = harness();
    await scheduler.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 60 * 60_000 },
      prompt: 'Summarize',
      target: TARGET,
      createdBy: CREATOR,
    });
    outcomes.push(...Array(threshold).fill('failed'));
    for (let run = 0; run < threshold; run += 1)
      await scheduler.runJob('digest');
    await vi.waitFor(() => expect(fatigueBells()).toHaveLength(1));
    expect(await job()).toMatchObject({ enabled: false });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.enableJob('digest');
    expect(await job()).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
    });
    // One more failure is one, not six: it stays on.
    outcomes.push('failed');
    await scheduler.runJob('digest');
    expect(await job()).toMatchObject({
      enabled: true,
      consecutiveFailures: 1,
    });
    expect(fatigueBells()).toHaveLength(1);
  });
});

describe('fix round: creator, dedicated binding, late count, capacity', () => {
  test('an edit never replaces the creator a targeted job acts as', async () => {
    const { scheduler, runs } = harness();
    const victim = { userId: 'victim-person' };
    await scheduler.addJob({
      name: 'victim-job',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Original',
      target: TARGET,
      createdBy: victim,
    });
    await scheduler.editJob('victim-job', {
      target: TARGET,
      createdBy: { userId: 'editor-person' },
    });
    expect((await scheduler.listJobs())[0]!.createdBy).toEqual(victim);
    await scheduler.runJob('victim-job');
    expect(runs[0]!.createdBy).toEqual(victim);
  });

  test('a legacy job that gains a target takes its editor as creator', async () => {
    const { scheduler } = harness();
    await scheduler.addJob({
      name: 'legacy',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'x',
    });
    await scheduler.editJob('legacy', { target: TARGET, createdBy: CREATOR });
    expect((await scheduler.listJobs())[0]!.createdBy).toEqual(CREATOR);
  });

  test('a dedicated start that returns after the target changed binds nothing', async () => {
    const { scheduler, runs, job } = harness();
    await scheduler.addJob({
      name: 'own-chat',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'Summarize',
      target: { kind: 'dedicated', agent: 'old-agent' },
      createdBy: CREATOR,
    });
    await scheduler.runJob('own-chat');
    await scheduler.editJob('own-chat', {
      target: { kind: 'dedicated', agent: 'new-agent' },
    });
    runs[0]!.onConversationStarted('old-agent-chat');
    expect((await job()).target).toEqual({
      kind: 'dedicated',
      agent: 'new-agent',
    });
  });

  test('a late catch-up counts every occurrence it skipped', () => {
    const root = makeTempDir('station-automation-late-count-');
    const ledger = createSchedulerLedger({ directory: root });
    ledger.create({
      name: 'late',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      prompt: 'x',
      enabled: true,
      createdAt: '2026-10-20T00:00:00.000Z',
      target: TARGET,
      createdBy: CREATOR,
    });
    ledger.claimDue(Date.parse('2026-10-27T20:00:00.000Z'));
    const logs = ledger.logs('late');
    if (logs.kind !== 'available') throw new Error('storage unavailable');
    // October 20 through 27 at 09:00: eight occurrences, none run.
    expect(logs.value[0]).toMatchObject({ skipped: 'late', missedCount: 8 });
    ledger.close();
  });

  test('four conversation runs waiting on their turns do not starve an unrelated job', async () => {
    const root = makeTempDir('station-automation-capacity-');
    const invoke = vi.fn(async () => ({
      kind: 'completed' as const,
      output: 'ok',
    }));
    const waiting: string[] = [];
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: root }),
      turnAdapter: { invoke },
      conversationRuns: {
        run: (input) => {
          waiting.push(input.jobName);
          // Queued in the chat, then waiting (say, on an approval).
          input.onHandedOff();
          return new Promise((resolve) =>
            input.signal.addEventListener(
              'abort',
              () => resolve({ kind: 'indeterminate', error: 'stopped' }),
              { once: true },
            ),
          );
        },
      },
    });
    schedulers.push(scheduler);
    const timeMs = Date.now() - 1_000;
    for (let index = 0; index < 4; index += 1)
      await scheduler.addJob({
        name: `waiting-${index}`,
        schedule: { kind: 'at', timeMs, deleteAfterRun: false },
        prompt: 'x',
        target: TARGET,
        createdBy: CREATOR,
      });
    await scheduler.addJob({
      name: 'legacy',
      schedule: { kind: 'at', timeMs, deleteAfterRun: false },
      prompt: 'x',
    });
    scheduler.start();
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });
});

describe('fix round: a turn that ends in an engine error fails the run', () => {
  test('runtime.error is read as a turn terminal', () => {
    expect(SCHEDULED_TURN_TERMINAL_METHODS).toContain('runtime.error');
  });

  test.each(['claude', 'codex'])(
    'a %s failure terminal fails the run at once',
    (provider) => {
      expect(
        readScheduledTurnTerminal([
          {
            method: 'runtime.error',
            provider,
            message: 'quota exceeded',
            retriable: false,
          },
        ]),
      ).toEqual({
        kind: 'failed',
        reason: 'The engine reported an error: quota exceeded',
      });
    },
  );

  test('a Codex error the engine retries in the same turn decides nothing', () => {
    const retrying = {
      method: 'runtime.error',
      provider: 'codex',
      message: 'reconnecting',
      retriable: true,
    };
    expect(readScheduledTurnTerminal([retrying])).toBeUndefined();
    expect(
      readScheduledTurnTerminal([retrying, { method: 'turn.completed' }]),
    ).toEqual({ kind: 'completed' });
  });
});
