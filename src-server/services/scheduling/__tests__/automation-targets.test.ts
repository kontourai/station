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
import type {
  ScheduledConversationRunInput,
  ScheduledConversationRunOutcome,
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
