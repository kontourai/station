/**
 * The Automations list read: each job's last outcomes and whether Station
 * paused it itself. Real `BuiltinScheduler` and SQLite ledger behind the real
 * `GET /jobs` route; only the conversation runner is scripted, because what
 * is under test is what the list read reports about the runs the scheduler
 * recorded.
 */
import {
  AUTOMATION_RUN_POLICY,
  SCHEDULER_RECENT_OUTCOMES_LIMIT,
  type SchedulerJob,
} from '@kontourai/station-contracts/scheduler';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BuiltinScheduler } from '../../../services/scheduling/builtin-scheduler.js';
import type { ScheduledConversationRunOutcome } from '../../../services/scheduling/scheduled-conversation-runs.js';
import { createSchedulerLedger } from '../../../services/scheduling/scheduler-ledger.js';
import { createSchedulerRoutes } from '../scheduler.js';

const makeTempDir = trackTempDirs();
const schedulers: BuiltinScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
});

const TARGET = { kind: 'conversation', conversationId: 'chat-1' } as const;
const CREATOR = { userId: 'human:local:operator' };
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

function harness(
  options: { mayReadRun?: (job: SchedulerJob) => boolean } = {},
) {
  const root = makeTempDir('station-list-outcomes-');
  const ledger = createSchedulerLedger({ directory: root });
  const outcomes: ScheduledConversationRunOutcome['kind'][] = [];
  const scheduler = new BuiltinScheduler({
    ledger,
    turnAdapter: {
      invoke: async () => ({
        kind: 'definitely-not-invoked' as const,
        error: 'provider unavailable',
      }),
    },
    conversationRuns: {
      run: async () => {
        const kind = outcomes.shift() ?? 'completed';
        return kind === 'completed'
          ? { kind, output: '{}', conversationId: 'chat-1' }
          : kind === 'failed'
            ? { kind, error: 'The turn stopped.', conversationId: 'chat-1' }
            : { kind: 'indeterminate', error: 'unknown' };
      },
    },
    notificationService: {
      dispatch: (_operation: string, task: () => Promise<unknown>) => {
        void task().catch(() => undefined);
        return true;
      },
      schedule: vi.fn().mockResolvedValue(undefined),
    } as never,
  });
  schedulers.push(scheduler);
  const service = {
    listJobs: () => scheduler.listJobs(),
    // One summary per job, so the route's run visibility check has a run to
    // decide on.
    listRunSummaries: async () =>
      (await scheduler.listJobs()).map((job) => ({
        runId: `schedule:built-in:${job.name}:fixture`,
        providerId: 'built-in',
        source: 'schedule',
        sourceId: job.name,
        status: 'completed',
        startedAt: new Date().toISOString(),
      })),
  };
  const app = createSchedulerRoutes(service as never, logger as never, {
    mayReadAutomationJob: () => true,
    mayReadAutomationRun: (_c, job) => options.mayReadRun?.(job) ?? true,
  });
  const list = async (): Promise<SchedulerJob[]> => {
    const response = await app.request('/jobs');
    expect(response.status).toBe(200);
    return (await json(response)).data;
  };
  const listed = async (name: string) =>
    (await list()).find((job) => job.name === name)!;
  return { ledger, scheduler, outcomes, list, listed };
}

async function addTargeted(
  scheduler: BuiltinScheduler,
  name: string,
  schedule: SchedulerJob['schedule'] = { kind: 'every', everyMs: 3_600_000 },
) {
  await scheduler.addJob({
    name,
    schedule,
    prompt: 'Summarize',
    target: TARGET,
    createdBy: CREATOR,
  });
}

describe('GET /jobs recent outcomes', () => {
  test(`carries the last ${SCHEDULER_RECENT_OUTCOMES_LIMIT} outcomes per automation, oldest first`, async () => {
    expect(SCHEDULER_RECENT_OUTCOMES_LIMIT).toBe(12);
    const { scheduler, outcomes, listed } = harness();
    await addTargeted(scheduler, 'digest');
    await addTargeted(scheduler, 'fresh');
    // 14 runs. The first two fall off the strip; `more` says so.
    const ran: ScheduledConversationRunOutcome['kind'][] = [
      'failed',
      'failed',
      'completed',
      'completed',
      'indeterminate',
      'completed',
      'completed',
      'failed',
      'completed',
      'completed',
      'completed',
      'completed',
      'failed',
      'completed',
    ];
    outcomes.push(...ran);
    for (const _ of ran) await scheduler.runJob('digest');
    outcomes.push('completed', 'failed');
    await scheduler.runJob('fresh');
    await scheduler.runJob('fresh');

    expect((await listed('digest')).recentOutcomes).toEqual({
      outcomes: [
        'worked',
        'worked',
        'unknown',
        'worked',
        'worked',
        'failed',
        'worked',
        'worked',
        'worked',
        'worked',
        'failed',
        'worked',
      ],
      more: true,
    });
    expect((await listed('fresh')).recentOutcomes).toEqual({
      outcomes: ['worked', 'failed'],
      more: false,
    });
  });

  test('an automation with no runs has an empty strip, not an unknown one', async () => {
    const { scheduler, listed } = harness();
    await addTargeted(scheduler, 'never-ran');
    expect((await listed('never-ran')).recentOutcomes).toEqual({
      outcomes: [],
      more: false,
    });
  });

  test('a run that retried is one outcome, decided by its last attempt', async () => {
    const { scheduler, listed } = harness();
    await scheduler.addJob({
      name: 'legacy',
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'x',
      retryCount: 4,
      retryDelaySecs: 0,
    });
    await scheduler.runJob('legacy');
    expect(await scheduler.getJobLogs('legacy')).toHaveLength(5);
    expect((await listed('legacy')).recentOutcomes).toEqual({
      outcomes: ['failed'],
      more: false,
    });
  });

  test('a late occurrence recorded missed reads as skipped', async () => {
    const { ledger, scheduler, listed } = harness();
    const dueAt = Date.now() + 60_000;
    await addTargeted(scheduler, 'late', { kind: 'at', timeMs: dueAt });
    // Station "was off" until well past the lateness cutoff.
    const claimed = ledger.claimDue(
      dueAt + AUTOMATION_RUN_POLICY.latenessCutoffMs + 60_000,
    );
    expect(claimed).toMatchObject({ kind: 'available', value: [] });
    expect((await listed('late')).recentOutcomes).toEqual({
      outcomes: ['skipped'],
      more: false,
    });
  });

  test('a reader who may not read every run gets no outcomes or pause reason', async () => {
    const threshold = AUTOMATION_RUN_POLICY.fatigueFailureThreshold;
    const { scheduler, outcomes, listed } = harness({
      mayReadRun: (job) => job.name !== 'private',
    });
    await addTargeted(scheduler, 'private');
    outcomes.push(...Array(threshold).fill('failed'));
    for (let run = 0; run < threshold; run += 1)
      await scheduler.runJob('private');
    const job = await listed('private');
    expect(job.enabled).toBe(false);
    expect(job).not.toHaveProperty('recentOutcomes');
    expect(job).not.toHaveProperty('pausedItself');
    expect(job).not.toHaveProperty('consecutiveFailures');
  });
});

describe('GET /jobs paused itself', () => {
  const threshold = AUTOMATION_RUN_POLICY.fatigueFailureThreshold;

  test('is present after Station turns an automation off for failures, until a person turns it back on', async () => {
    const { scheduler, outcomes, listed } = harness();
    await addTargeted(scheduler, 'digest');
    outcomes.push(...Array(threshold).fill('failed'));
    for (let run = 0; run < threshold; run += 1)
      await scheduler.runJob('digest');

    const paused = await listed('digest');
    expect(paused.enabled).toBe(false);
    expect(paused.pausedItself).toEqual({
      failures: threshold,
      at: expect.any(String),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.enableJob('digest');
    expect(await listed('digest')).not.toHaveProperty('pausedItself');

    // A person pausing it afterwards is not Station pausing it.
    await scheduler.disableJob('digest');
    const byPerson = await listed('digest');
    expect(byPerson.enabled).toBe(false);
    expect(byPerson).not.toHaveProperty('pausedItself');
  });

  test('is absent on an automation a person paused', async () => {
    const { scheduler, outcomes, listed } = harness();
    await addTargeted(scheduler, 'digest');
    outcomes.push('failed', 'failed');
    await scheduler.runJob('digest');
    await scheduler.runJob('digest');
    await scheduler.disableJob('digest');
    const job = await listed('digest');
    expect(job).toMatchObject({ enabled: false, consecutiveFailures: 2 });
    expect(job).not.toHaveProperty('pausedItself');
  });
});
