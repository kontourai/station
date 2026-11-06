/**
 * #4554: resuming an ended Task, at the Task store and its dispatcher.
 *
 * Real pieces: `TaskGraphService` over an on-disk `task-graph.json`, its
 * Task worktree store and custody queue, and the real `TaskDispatcher`
 * composition (seeded `task-dispatch` starts, which need no engine). The
 * stand-ins are the authority and turn ports the runtime supplies (each
 * test names the answer it gives) and the worktree provisioner, whose git
 * work is not under test here.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  TASK_RESUME_MAX_PER_INCARNATION,
  TASK_RESUME_WINDOW_MS,
  type TaskResumeRequest,
  taskResumeRefusal,
} from '@kontourai/station-contracts/task-resume';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import {
  TaskGraphService,
  type TaskGraphService as TaskGraphServiceType,
  type TaskResumeInput,
  TaskResumeRefusedError,
  taskGraphPreResumeSnapshotPath,
} from '../task-graph-service.js';
import { TaskWorktreeStore } from '../task-worktree-store.js';

const makeTempDir = trackTempDirs();
const PROJECT = 'project-alpha';
const REF = 'github:kontourai/station#7';
const OPERATOR = 'human:local:operator';
const OBSERVED = '2026-11-01T00:00:00.000Z';

const projectService = {
  getProject: (slug: string) => {
    if (slug !== PROJECT) throw new Error('missing project');
    return {
      id: PROJECT,
      slug: PROJECT,
      name: 'Project alpha',
      createdAt: OBSERVED,
      updatedAt: OBSERVED,
    };
  },
};

type Deps = ConstructorParameters<typeof TaskGraphService>[1];

/** A GitHub Task's dispatch claims its work item; this provider grants it. */
function serviceDeps(homeDir: string, deps: Deps = {}): Deps {
  return {
    projectService: projectService as never,
    resolveProjectWorkspace: () => homeDir,
    assignmentClaimService: {
      claim: async () => ({
        outcome: 'claimed',
        record: { claimed_at: OBSERVED },
      }),
      release: async () => ({ outcome: 'released' }),
      status: async () => ({ outcome: 'unclaimed' }),
    } as never,
    ...deps,
  };
}

function world(deps: Deps = {}, homeDir = makeTempDir('task-resume-')) {
  const graph = new TaskGraphService(homeDir, serviceDeps(homeDir, deps));
  return { homeDir, graph };
}

/** A board-checked GitHub Task a seeded dispatch attached a lead to, ended. */
async function endedTask(
  graph: TaskGraphServiceType,
  options: { ref?: string; status?: 'done' | 'canceled' } = {},
): Promise<TaskRecord> {
  const { task } = await graph.createTaskForWorkItem(
    { projectId: PROJECT, title: 'Fix it', workItemRef: options.ref ?? REF },
    OBSERVED,
  );
  const dispatcher = composeTaskDispatcher(graph);
  const outcome = await dispatcher.dispatch(task.id, {
    ownerUserId: 'human:local:earlier-owner',
  });
  expect(outcome.kind).toBe('dispatched');
  // A seeded dispatch leaves the Task ready with its lead attached.
  await graph.updateTaskStatus(task.id, 'in_progress');
  await graph.updateTaskStatus(task.id, options.status ?? 'done');
  return graph.readTask(task.id)!;
}

function request(
  task: TaskRecord,
  overrides: Partial<TaskResumeRequest> = {},
): TaskResumeRequest {
  return {
    resumeId: 'resume-1',
    expectedCreatedAt: task.createdAt,
    expectedEndedAt: task.endedAt!,
    reason: 'The reviewer asked for one more test.',
    ...overrides,
  };
}

function input(
  task: TaskRecord,
  overrides: Partial<TaskResumeInput> = {},
): TaskResumeInput {
  return {
    taskId: task.id,
    request: request(task),
    principalId: OPERATOR,
    authorize: () => true,
    isTaskSessionTurnActive: () => false,
    leadOwnerOf: () => 'human:local:earlier-owner',
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaskResumeRefusedError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const storeBytes = (homeDir: string) =>
  readFileSync(join(homeDir, 'task-graph.json'), 'utf8');

describe('end time (#4554 slice 1)', () => {
  test('a move into done or canceled writes endedAt once; edits never move it', async () => {
    const { graph } = world();
    const done = await endedTask(graph);
    expect(done.status).toBe('done');
    expect(done.endedAt).toBe(done.updatedAt);
    await graph.updateTaskTitle(done.id, 'Renamed', done.createdAt);
    const renamed = graph.readTask(done.id)!;
    expect(renamed.updatedAt > done.updatedAt).toBe(true);
    expect(renamed.endedAt).toBe(done.endedAt);

    const canceled = await endedTask(graph, {
      ref: 'github:kontourai/station#8',
      status: 'canceled',
    });
    expect(canceled.endedAt).toBe(canceled.updatedAt);
  });

  test('the store refuses an end time on a live Task and a resume naming another incarnation', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    const path = join(homeDir, 'task-graph.json');
    const original = readFileSync(path, 'utf8');
    const document = JSON.parse(original);
    document.tasks[0].status = 'ready';
    writeFileSync(path, JSON.stringify(document));
    const fresh = new TaskGraphService(homeDir, serviceDeps(homeDir));
    expect(() => fresh.readTask(done.id)).toThrow(
      /endedAt: only an ended Task has an end time/,
    );
    const forged = JSON.parse(original);
    forged.tasks[0].resumes = [
      {
        resumeId: 'resume-1',
        taskId: done.id,
        taskCreatedAt: '2020-01-01T00:00:00.000Z',
        fromStatus: 'done',
        endedAt: done.endedAt,
        resumedAt: done.endedAt,
        resumedBy: OPERATOR,
        reason: 'Forged onto another incarnation',
      },
    ];
    writeFileSync(path, JSON.stringify(forged));
    expect(() => fresh.readTask(done.id)).toThrow(
      /taskCreatedAt: must be the Task's incarnation/,
    );
  });
});

describe('storage migration (#4554)', () => {
  test('the first write with the new fields keeps the pre-migration document; later writes keep that first copy', async () => {
    const { graph, homeDir } = world();
    const { task } = await graph.createTaskForWorkItem(
      { projectId: PROJECT, title: 'Old', workItemRef: REF },
      OBSERVED,
    );
    await graph.updateTaskStatus(task.id, 'in_progress');
    const before = storeBytes(homeDir);
    const snapshot = taskGraphPreResumeSnapshotPath(
      join(homeDir, 'task-graph.json'),
    );
    expect(existsSync(snapshot)).toBe(false);
    await graph.updateTaskStatus(task.id, 'done');
    expect(readFileSync(snapshot, 'utf8')).toBe(before);
    expect(JSON.parse(before).tasks[0].endedAt).toBeUndefined();
    // Another end does not replace the first copy.
    const { task: second } = await graph.createTaskForWorkItem(
      { projectId: PROJECT, title: 'Two', workItemRef: 'github:a/b#1' },
      OBSERVED,
    );
    await graph.updateTaskStatus(second.id, 'canceled');
    expect(readFileSync(snapshot, 'utf8')).toBe(before);
  });

  test('a legacy done Task without endedAt is refused as end time unknown and nothing is written', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    const path = join(homeDir, 'task-graph.json');
    const document = JSON.parse(readFileSync(path, 'utf8'));
    delete document.tasks[0].endedAt;
    writeFileSync(path, JSON.stringify(document));
    const legacy = graph.readTask(done.id)!;
    expect(taskResumeRefusal(legacy)).toBe('task_resume_end_unknown');
    const bytes = storeBytes(homeDir);
    expect(await refusal(graph.resumeTask(input(done)))).toBe(
      'task_resume_end_unknown',
    );
    expect(storeBytes(homeDir)).toBe(bytes);
  });
});

describe('resume (#4554 slice 2)', () => {
  test('moves done to ready, clears endedAt, close-on-merge and the lead attachment, and records one receipt', async () => {
    const { graph } = world();
    const { task } = await graph.createTaskForWorkItem(
      { projectId: PROJECT, title: 'Fix it', workItemRef: REF },
      OBSERVED,
    );
    await composeTaskDispatcher(graph).dispatch(task.id, {
      ownerUserId: 'human:local:earlier-owner',
    });
    await graph.updateTaskStatus(task.id, 'in_progress');
    await graph.setCloseOnMerge(task.id, true);
    await graph.updateTaskStatus(task.id, 'done');
    const done = graph.readTask(task.id)!;
    expect(done.closeOnMerge).toBe(true);
    expect(done.sessionId).toBeDefined();

    const result = await graph.resumeTask(
      input(done, {
        request: request(done, { followUpsSeenThrough: done.endedAt }),
      }),
    );
    expect(result.replayed).toBe(false);
    const stored = graph.readTask(task.id)!;
    expect(stored).toEqual(result.task);
    expect(stored.status).toBe('ready');
    expect(stored.endedAt).toBeUndefined();
    expect(stored.closeOnMerge).toBeUndefined();
    expect(stored.sessionId).toBeUndefined();
    expect(stored.dispatchedAt).toBeUndefined();
    // The mandate is untouched.
    expect(stored.title).toBe(done.title);
    expect(stored.workItemRef).toBe(done.workItemRef);
    expect(stored.createdBy).toBe(done.createdBy);
    expect(stored.resumes).toEqual([
      {
        resumeId: 'resume-1',
        taskId: task.id,
        taskCreatedAt: done.createdAt,
        fromStatus: 'done',
        endedAt: done.endedAt,
        resumedAt: stored.updatedAt,
        resumedBy: OPERATOR,
        reason: 'The reviewer asked for one more test.',
        previousLeadOwner: 'human:local:earlier-owner',
        previousSessionId: done.sessionId,
        previousDispatchedAt: done.dispatchedAt,
        followUpsSeenThrough: done.endedAt,
      },
    ]);
    // The general status route still has no way out of done or canceled.
    await expect(graph.updateTaskStatus(task.id, 'done')).rejects.toThrow(
      /Cannot transition task from ready to done/,
    );
  });

  test('authority is read under the lock immediately before the write, against the current Task', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    const seen: TaskRecord[] = [];
    const bytes = storeBytes(homeDir);
    expect(
      await refusal(
        graph.resumeTask(
          input(done, {
            authorize: (task) => {
              seen.push(task);
              return false;
            },
          }),
        ),
      ),
    ).toBe('task_resume_not_permitted');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.createdAt).toBe(done.createdAt);
    expect(storeBytes(homeDir)).toBe(bytes);
    // An authority port that throws is a refusal, never a pass.
    expect(
      await refusal(
        graph.resumeTask(
          input(done, {
            authorize: () => {
              throw new Error('membership store unreadable');
            },
          }),
        ),
      ),
    ).toBe('task_resume_not_permitted');
    expect(storeBytes(homeDir)).toBe(bytes);
  });

  test('each refusal writes nothing', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    const run = async (code: string, promise: Promise<unknown>) => {
      const bytes = storeBytes(homeDir);
      expect(await refusal(promise)).toBe(code);
      expect(storeBytes(homeDir)).toBe(bytes);
    };
    await run(
      'task_resume_conflict',
      graph.resumeTask(
        input(done, {
          request: request(done, { expectedCreatedAt: OBSERVED }),
        }),
      ),
    );
    await run(
      'task_resume_conflict',
      graph.resumeTask(
        input(done, {
          request: request(done, {
            expectedEndedAt: new Date(
              Date.parse(done.endedAt!) - 1,
            ).toISOString(),
          }),
        }),
      ),
    );
    await run(
      'task_resume_expired',
      graph.resumeTask(
        input(done, {
          now: () => Date.parse(done.endedAt!) + TASK_RESUME_WINDOW_MS + 1,
        }),
      ),
    );
    await run(
      'task_resume_turn_running',
      graph.resumeTask(input(done, { isTaskSessionTurnActive: () => true })),
    );
    await run(
      'task_resume_turn_running',
      graph.resumeTask(
        input(done, {
          isTaskSessionTurnActive: () => {
            throw new Error('unknown');
          },
        }),
      ),
    );
    // The window's own edge is still inside it.
    const edge = await graph.resumeTask(
      input(done, {
        now: () => Date.parse(done.endedAt!) + TASK_RESUME_WINDOW_MS,
      }),
    );
    expect(edge.task.status).toBe('ready');
  });

  test('canceled, live, non-GitHub and automation-owned Tasks are refused', async () => {
    const { graph } = world();
    const canceled = await endedTask(graph, {
      ref: 'github:kontourai/station#9',
      status: 'canceled',
    });
    expect(await refusal(graph.resumeTask(input(canceled)))).toBe(
      'task_resume_canceled',
    );

    const local = await graph.createTask({
      projectId: PROJECT,
      title: 'Local',
    });
    await graph.updateTaskStatus(local.id, 'in_progress');
    await graph.updateTaskStatus(local.id, 'done');
    const localDone = graph.readTask(local.id)!;
    expect(await refusal(graph.resumeTask(input(localDone)))).toBe(
      'task_resume_not_supported',
    );

    const { task: automated } = await graph.createTaskForWorkItem(
      {
        projectId: PROJECT,
        title: 'Repair',
        workItemRef: 'github:kontourai/station#10',
        createdBy: 'automation-rule',
      },
      OBSERVED,
    );
    await graph.updateTaskStatus(automated.id, 'in_progress');
    await graph.updateTaskStatus(automated.id, 'done');
    expect(
      await refusal(graph.resumeTask(input(graph.readTask(automated.id)!))),
    ).toBe('task_resume_not_supported');

    const { task: live } = await graph.createTaskForWorkItem(
      {
        projectId: PROJECT,
        title: 'Live',
        workItemRef: 'github:kontourai/station#11',
      },
      OBSERVED,
    );
    expect(
      await refusal(
        graph.resumeTask(
          input(live, {
            request: { ...request(live), expectedEndedAt: OBSERVED },
          }),
        ),
      ),
    ).toBe('task_resume_not_ended');
  });

  test('refused while another open Task holds the work item, naming it', async () => {
    const { graph } = world();
    const done = await endedTask(graph);
    const { task: other } = await graph.createTaskForWorkItem(
      { projectId: PROJECT, title: 'New Task', workItemRef: REF },
      OBSERVED,
    );
    try {
      await graph.resumeTask(input(done));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskResumeRefusedError);
      expect((error as TaskResumeRefusedError).code).toBe(
        'task_resume_work_item_taken',
      );
      expect((error as TaskResumeRefusedError).existing).toEqual({
        id: other.id,
        projectId: PROJECT,
      });
    }
  });

  test('the 21st resume of one incarnation is refused', async () => {
    const { graph } = world();
    let task = await endedTask(graph);
    for (let index = 0; index < TASK_RESUME_MAX_PER_INCARNATION; index += 1) {
      await graph.resumeTask(
        input(task, { request: request(task, { resumeId: `r-${index}` }) }),
      );
      await graph.updateTaskStatus(task.id, 'in_progress');
      await graph.updateTaskStatus(task.id, 'done');
      task = graph.readTask(task.id)!;
    }
    expect(task.resumes).toHaveLength(TASK_RESUME_MAX_PER_INCARNATION);
    expect(
      await refusal(
        graph.resumeTask(
          input(task, { request: request(task, { resumeId: 'last' }) }),
        ),
      ),
    ).toBe('task_resume_limit');
  });
});

describe('exactly once (#4554)', () => {
  test('a retry with the same key and inputs replays the receipt with the Task as it is now, also after a restart and a dispatch', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    const first = await graph.resumeTask(input(done));

    // "Restart": a new service over the same home; the response was lost.
    const restarted = new TaskGraphService(homeDir, serviceDeps(homeDir));
    const replay = await restarted.resumeTask(input(done));
    expect(replay.replayed).toBe(true);
    expect(replay.resume).toEqual(first.resume);
    expect(replay.task).toEqual(restarted.readTask(done.id));

    // After a dispatch, the replay answers the current Task, not `ready`.
    const outcome = await composeTaskDispatcher(restarted).dispatch(done.id, {
      ownerUserId: OPERATOR,
    });
    expect(outcome.kind).toBe('dispatched');
    const after = await restarted.resumeTask(input(done));
    expect(after.replayed).toBe(true);
    expect(after.task).toEqual(restarted.readTask(done.id));
    expect(after.task.sessionId).toBeDefined();
    expect(after.task.sessionId).not.toBe(done.sessionId);
    expect(after.task.dispatchedAt).toBeDefined();
    expect(after.resume).toEqual(first.resume);
    expect(restarted.readTask(done.id)?.resumes).toHaveLength(1);
  });

  test('the same key with other inputs conflicts; another principal or revoked authority learns nothing', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    await graph.resumeTask(input(done));
    const bytes = storeBytes(homeDir);
    expect(
      await refusal(
        graph.resumeTask(
          input(done, { request: request(done, { reason: 'Other words' }) }),
        ),
      ),
    ).toBe('task_resume_conflict');
    expect(
      await refusal(
        graph.resumeTask(input(done, { principalId: 'human:local:someone' })),
      ),
    ).toBe('task_resume_not_permitted');
    expect(
      await refusal(graph.resumeTask(input(done, { authorize: () => false }))),
    ).toBe('task_resume_not_permitted');
    expect(storeBytes(homeDir)).toBe(bytes);
  });

  test('of two concurrent resumes with different keys, one commits and the other conflicts', async () => {
    const { graph } = world();
    const done = await endedTask(graph);
    const outcomes = await Promise.allSettled([
      graph.resumeTask(
        input(done, { request: request(done, { resumeId: 'a' }) }),
      ),
      graph.resumeTask(
        input(done, { request: request(done, { resumeId: 'b' }) }),
      ),
    ]);
    const committed = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(committed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(
      ((refused[0] as PromiseRejectedResult).reason as TaskResumeRefusedError)
        .code,
    ).toBe('task_resume_conflict');
    expect(graph.readTask(done.id)?.resumes).toHaveLength(1);
  });

  test('two concurrent retries of one key commit once and both answer the same receipt', async () => {
    const { graph } = world();
    const done = await endedTask(graph);
    const [a, b] = await Promise.all([
      graph.resumeTask(input(done)),
      graph.resumeTask(input(done)),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.resume).toEqual(b.resume);
    expect(graph.readTask(done.id)?.resumes).toHaveLength(1);
  });
});

describe('dispatch after resume (#4554)', () => {
  test('a dispatch reservation that expires restores the empty attachment, never the earlier lead', async () => {
    const { graph, homeDir } = world();
    const done = await endedTask(graph);
    await graph.resumeTask(input(done));
    // A dispatch whose process died after its reservation: write the
    // reservation the dispatcher writes, already expired.
    const path = join(homeDir, 'task-graph.json');
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const reservedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const expiresAt = new Date(
      Date.parse(reservedAt) + 5 * 60 * 1000,
    ).toISOString();
    const task = document.tasks[0];
    Object.assign(task, {
      status: 'in_progress',
      sessionId: 'task-session-new',
      dispatchedAt: reservedAt,
      updatedAt: reservedAt,
      dispatchReservation: {
        generation: '11111111-1111-4111-8111-111111111111',
        phase: 'pre_provider',
        sessionId: 'task-session-new',
        reservedAt,
        expiresAt,
        priorStatus: 'ready',
      },
    });
    writeFileSync(path, JSON.stringify(document));
    // Any mutation reconciles the expired lease.
    await graph.updateTaskTitle(done.id, 'Touched', done.createdAt);
    const restored = graph.readTask(done.id)!;
    expect(restored.status).toBe('ready');
    expect(restored.sessionId).toBeUndefined();
    expect(restored.dispatchedAt).toBeUndefined();
  });

  test('a resumed Task’s first dispatch refuses a kept worktree that is busy, and reuses it once free', async () => {
    let busy = true;
    const provisioned: (WorktreeSessionMetadata | undefined)[] = [];
    const homeDir = makeTempDir('task-resume-worktree-');
    const worktree: WorktreeSessionMetadata = {
      mode: 'worktree',
      repoPath: join(homeDir, 'repo'),
      path: join(homeDir, 'repo-worktrees', 'task'),
      branch: 'task/branch',
      baseRef: 'main',
      cleanupPolicy: 'cleanup',
      preserveOnFailure: true,
      createdAt: OBSERVED,
    };
    const { graph } = world(
      {
        isWorkspaceBusy: () => busy,
        worktreeProvisioning: {
          provisionForTask: async (request) => {
            provisioned.push(request.recorded);
            return {
              metadata: request.recorded ?? worktree,
              provenance: request.recorded ? 'reused' : 'created',
            } as never;
          },
          finalizeForTask: async () =>
            ({ outcome: 'kept', reason: 'session-running' }) as never,
        },
      },
      homeDir,
    );
    const done = await endedTask(graph);
    worktree.owner = { kind: 'task', taskId: done.id };
    await new TaskWorktreeStore(homeDir).update(done.id, () => ({
      taskCreatedAt: done.createdAt,
      worktree,
    }));
    // Busy at resume: refused, distinct from the Session turn check.
    expect(await refusal(graph.resumeTask(input(done)))).toBe(
      'task_resume_turn_running',
    );
    busy = false;
    await graph.resumeTask(input(done));
    // A turn starts in the kept checkout after the resume.
    busy = true;
    const adapters = graph.createTaskDispatchAdapters({
      orchestrationService: {} as never,
      resolveAgentStart: async () =>
        ({
          agentId: 'agent',
          provider: 'codex',
          cwd: worktree.repoPath,
          workspaceIsolation: { mode: 'worktree' },
          metadata: {},
        }) as never,
    });
    const refusedPrepare = await adapters.remoteSessions.prepare!(done.id, {
      agentId: 'agent',
    } as never);
    expect(refusedPrepare).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('kept worktree has a running turn'),
    });
    expect(provisioned).toEqual([]);
    busy = false;
    const ready = await adapters.remoteSessions.prepare!(done.id, {
      agentId: 'agent',
    } as never);
    expect(ready).toMatchObject({ kind: 'ready' });
    expect(provisioned).toEqual([worktree]);
  });
});

describe('custody (#4554)', () => {
  test('resume waits for a finalization already running, and a finalization after resume does nothing', async () => {
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let finalizations = 0;
    let finalizeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizeStarted = resolve;
    });
    const homeDir = makeTempDir('task-resume-custody-');
    const { graph } = world(
      {
        worktreeProvisioning: {
          provisionForTask: async () => {
            throw new Error('unused');
          },
          finalizeForTask: async () => {
            finalizations += 1;
            finalizeStarted();
            await finalizeGate;
            return { outcome: 'kept', reason: 'session-running' } as never;
          },
        },
      },
      homeDir,
    );
    const { task } = await graph.createTaskForWorkItem(
      { projectId: PROJECT, title: 'Fix it', workItemRef: REF },
      OBSERVED,
    );
    await new TaskWorktreeStore(homeDir).update(task.id, () => ({
      taskCreatedAt: task.createdAt,
      worktree: {
        mode: 'worktree',
        repoPath: join(homeDir, 'repo'),
        path: join(homeDir, 'wt'),
        branch: 'b',
        baseRef: 'main',
        cleanupPolicy: 'cleanup',
        preserveOnFailure: true,
        createdAt: OBSERVED,
        owner: { kind: 'task', taskId: task.id },
      },
    }));
    await graph.updateTaskStatus(task.id, 'in_progress');
    await graph.updateTaskStatus(task.id, 'done'); // starts finalization
    await started;
    const done = graph.readTask(task.id)!;
    let resumed = false;
    const resume = graph.resumeTask(input(done)).then((result) => {
      resumed = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumed).toBe(false);
    expect(graph.readTask(task.id)?.status).toBe('done');
    releaseFinalize();
    expect((await resume).task.status).toBe('ready');
    // The deferral recorded by that finalization is dropped, and a retry
    // after the resume finalizes nothing.
    await graph.retryDeferredTaskWorktreeFinalizations();
    expect(finalizations).toBe(1);
    expect(graph.readTaskWorktree(task.id)).toBeDefined();
  });
});
