/**
 * #5070: scheduled jobs that belong to a Project, and #5069's hold on them.
 *
 * Real `BuiltinScheduler` and SQLite `SchedulerLedger`. The Project hold is
 * a mutable set, and the Project runner a recording fake: what is under
 * test is which runs the scheduler starts and what it hands the runner.
 * `ScheduledProjectRuns` (how a run becomes a Task) is tested below with
 * its own fakes.
 */
import { AUTOMATION_RUN_POLICY } from '@kontourai/station-contracts/scheduler';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  BuiltinScheduler,
  type ScheduledProjectRunner,
} from '../builtin-scheduler.js';
import type {
  ScheduledConversationRunInput,
  ScheduledConversationRunOutcome,
} from '../scheduled-conversation-runs.js';
import { ScheduledProjectRuns } from '../scheduled-project-runs.js';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();
const schedulers: BuiltinScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
});

const PROJECT = 'id-atlas';

function harness() {
  const root = makeTempDir('station-project-schedules-');
  const held = new Set<string>();
  const preview = { on: true };
  const invocations: Parameters<ScheduledProjectRunner['invoke']>[0][] = [];
  const turnAdapter = { invoke: vi.fn() };
  const ledger = createSchedulerLedger({ directory: root });
  const scheduler = new BuiltinScheduler({
    ledger,
    turnAdapter,
    projectRuns: {
      invoke: async (input) => {
        invocations.push(input);
        return { kind: 'completed', output: '{"taskId":"task-1"}' };
      },
    },
    projectHold: {
      heldProjectIds: () => held,
      heldProjectSlugs: () => new Set(),
      projectExists: (id) => id === PROJECT,
      projectRunsEnabled: () => preview.on,
    },
  });
  schedulers.push(scheduler);
  return { scheduler, ledger, held, preview, invocations, turnAdapter };
}

describe('a Project job', () => {
  test('is created with its Project and runs as a Project run, not a bare turn', async () => {
    const { scheduler, invocations, turnAdapter } = harness();
    await scheduler.addJob({
      name: 'monday-digest',
      schedule: { kind: 'cron', expr: '0 9 * * 1' },
      prompt: 'Summarize last week',
      agent: 'writer',
      projectId: PROJECT,
    });
    expect((await scheduler.listJobs())[0]).toMatchObject({
      name: 'monday-digest',
      projectId: PROJECT,
    });

    const receipt = await scheduler.runJob('monday-digest');

    expect(receipt.outcome).toBe('completed');
    expect(invocations).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        jobName: 'monday-digest',
        agentSlug: 'writer',
        prompt: 'Summarize last week',
      }),
    ]);
    expect(turnAdapter.invoke).not.toHaveBeenCalled();
  });

  test('does not fire while its Project is paused, and fires once released', async () => {
    const { scheduler, ledger, held, invocations } = harness();
    held.add(PROJECT);
    await scheduler.addJob({
      name: 'due-now',
      schedule: {
        kind: 'at',
        timeMs: Date.now() - 1_000,
        deleteAfterRun: false,
      },
      prompt: 'x',
      projectId: PROJECT,
    });

    // The scheduler's own claim: the held job is left unclaimed and unrun.
    scheduler.start();
    const claimedWhileHeld = ledger.claimDue(Date.now(), (job) =>
      Boolean(job.projectId && held.has(job.projectId)),
    );
    expect(claimedWhileHeld).toEqual({ kind: 'available', value: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invocations).toHaveLength(0);
    expect(ledger.logs('due-now')).toEqual({ kind: 'available', value: [] });
    await expect(scheduler.runJob('due-now')).rejects.toThrow(
      'belongs to a paused or archived Project',
    );
    expect(invocations).toHaveLength(0);

    held.delete(PROJECT);
    await scheduler.runJob('due-now');
    expect(invocations).toHaveLength(1);
  });

  test('with the Project schedules preview off, no Project job is claimed or run', async () => {
    const { scheduler, ledger, preview, invocations } = harness();
    await scheduler.addJob({
      name: 'due-now',
      schedule: {
        kind: 'at',
        timeMs: Date.now() - 1_000,
        deleteAfterRun: false,
      },
      prompt: 'x',
      projectId: PROJECT,
    });
    preview.on = false;
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ledger.logs('due-now')).toEqual({ kind: 'available', value: [] });
    await expect(scheduler.runJob('due-now')).rejects.toThrow(
      'Enable Project schedules',
    );
    expect(invocations).toHaveLength(0);
    preview.on = true;
    await scheduler.runJob('due-now');
    expect(invocations).toHaveLength(1);
  });

  test('a Project occurrence more than the cutoff late is recorded missed, not run', () => {
    const { ledger } = harness();
    ledger.create({
      name: 'weekly',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      prompt: 'x',
      projectId: PROJECT,
      enabled: true,
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    const now =
      Date.parse('2026-10-27T09:00:00.000Z') +
      AUTOMATION_RUN_POLICY.latenessCutoffMs +
      60_000;
    expect(ledger.claimDue(now)).toEqual({ kind: 'available', value: [] });
    const logs = ledger.logs('weekly');
    if (logs.kind !== 'available') throw new Error('expected logs');
    expect(logs.value).toEqual([expect.objectContaining({ skipped: 'late' })]);
  });

  test.each([
    [
      'an unknown Project',
      { projectId: 'id-missing' },
      'does not exist on this Station',
    ],
    [
      'a chat target as well',
      {
        projectId: PROJECT,
        target: { kind: 'conversation', conversationId: 'c' },
        createdBy: { userId: 'u' },
      },
      'runs as a Task in its Project',
    ],
  ] as const)('refuses %s', async (_label, extra, message) => {
    const { scheduler } = harness();
    await expect(
      scheduler.addJob({
        name: 'bad',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        prompt: 'x',
        ...extra,
      }),
    ).rejects.toThrow(message);
  });

  test('cannot move to another Project', async () => {
    const { scheduler } = harness();
    await scheduler.addJob({
      name: 'digest',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      prompt: 'x',
      projectId: PROJECT,
    });
    await expect(
      scheduler.editJob('digest', { projectId: 'id-birch' }),
    ).rejects.toThrow('cannot move');
  });

  test('is refused where Project runs are unavailable (hosted)', async () => {
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({
        directory: makeTempDir('station-project-schedules-off-'),
      }),
      turnAdapter: { invoke: vi.fn() },
    });
    schedulers.push(scheduler);
    await expect(
      scheduler.addJob({
        name: 'digest',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        prompt: 'x',
        projectId: PROJECT,
      }),
    ).rejects.toThrow('unavailable on this Station');
  });
});

describe('ScheduledProjectRuns', () => {
  function runner(
    options: {
      dispatch?: 'dispatched' | 'failed';
      outcome?: ScheduledConversationRunOutcome;
    } = {},
  ) {
    const tasks: { input: unknown; key: string }[] = [];
    const turns: ScheduledConversationRunInput[] = [];
    const summaries: unknown[] = [];
    const dispatches: unknown[] = [];
    const runs = new ScheduledProjectRuns({
      createTask: async (input, key) => {
        tasks.push({ input, key });
        return {
          id: 'task-1',
          createdAt: '2026-11-16T09:00:00.000Z',
          projectId: input.projectId,
        };
      },
      dispatchTask: async (input) => {
        dispatches.push(input);
        return options.dispatch === 'failed'
          ? { kind: 'failed', reason: 'no engine' }
          : ({
              kind: 'dispatched',
              result: { session: { threadId: 'session-1' } },
            } as never);
      },
      conversationForSession: (sessionId) =>
        sessionId === 'session-1' ? 'chat-of-task-1' : undefined,
      conversationRuns: {
        run: async (input) => {
          turns.push(input);
          return (
            options.outcome ?? {
              kind: 'completed',
              output: '{}',
              conversationId: 'chat-of-task-1',
            }
          );
        },
      },
      actor: { userId: 'operator', ownerAttribution: 'unattributed-agent' },
      recordSummary: (input) => summaries.push(input),
      now: () => new Date('2026-11-16T09:05:00.000Z'),
    });
    return { runs, tasks, turns, summaries, dispatches };
  }

  const invoke = (runs: ScheduledProjectRuns) =>
    runs.invoke({
      projectId: PROJECT,
      jobName: 'monday-digest',
      agentSlug: 'writer',
      prompt: 'Summarize last week',
      receipt: {} as never,
      approval: 'unattended-deny',
      principal: { kind: 'scheduled-job', jobId: 'job-1', runId: 'run-1' },
      signal: new AbortController().signal,
    });

  test('creates a Task in the Project, starts it, and sends the prompt as its first turn', async () => {
    const { runs, tasks, turns, summaries, dispatches } = runner();

    const outcome = await invoke(runs);

    expect(tasks).toEqual([
      {
        input: {
          projectId: PROJECT,
          title: 'Scheduled: monday-digest',
          description: 'Summarize last week',
          agentId: 'writer',
        },
        key: 'run-1',
      },
    ]);
    expect(dispatches).toEqual([
      expect.objectContaining({ taskId: 'task-1', agentId: 'writer' }),
    ]);
    // The turn lands in the dispatched Task's own chat, which is where the
    // dispatch stamped the Task brief for the first turn.
    expect(turns).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        prompt: 'Summarize last week',
        target: { kind: 'conversation', conversationId: 'chat-of-task-1' },
        createdBy: {
          userId: 'operator',
          ownerAttribution: 'unattributed-agent',
        },
      }),
    ]);
    expect(summaries).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        taskId: 'task-1',
        sessionId: 'session-1',
        text: expect.stringContaining(
          'Scheduled run of "monday-digest" finished',
        ),
      }),
    ]);
    expect(outcome).toMatchObject({ kind: 'completed' });
    expect(JSON.parse((outcome as { output: string }).output)).toMatchObject({
      projectId: PROJECT,
      taskId: 'task-1',
      sessionId: 'session-1',
    });
  });

  test('a Task that does not start sends no turn and is retryable', async () => {
    const { runs, turns } = runner({ dispatch: 'failed' });
    await expect(invoke(runs)).resolves.toEqual({
      kind: 'definitely-not-invoked',
      error: "The run's Task did not start: no engine",
    });
    expect(turns).toHaveLength(0);
  });

  test("a refused first turn fails the run: the Task's Session already started", async () => {
    const { runs, summaries } = runner({
      outcome: {
        kind: 'definitely-not-invoked',
        error: 'This Project is paused. Resume it to continue.',
      },
    });
    await expect(invoke(runs)).resolves.toEqual({
      kind: 'failed',
      error: 'This Project is paused. Resume it to continue.',
    });
    expect(summaries).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('did not start'),
      }),
    ]);
  });
});
