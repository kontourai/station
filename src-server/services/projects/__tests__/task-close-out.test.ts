/**
 * #3161: Task close-out on merge, over the REAL `TaskGraphService` (its
 * store, keep ledger, status transitions and mutation lock) and the real
 * reconciler. Only the forge is a stand-in: a fake provider that answers
 * each pull request with the state the test gives it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createTaskCloseOut } from '../task-close-out.js';
import { TaskGraphService } from '../task-graph-service.js';

const makeTempDir = trackTempDirs();

/** What a reconcile reports merged for the keeps it read. */
const mergedOf = (
  keeps: readonly import('@kontourai/station-contracts').TaskKeptDeclaredPullRequest[],
) =>
  keeps.map((keep) => ({
    declarationId: keep.provenance.declarationId,
    provider: keep.provider,
    host: keep.host,
    repository: keep.repository,
    ref: keep.ref,
    nativeId: keep.nativeId,
  }));

const answer = (data: PullRequest): PullRequestResult<PullRequest> => ({
  available: true,
  data,
  effectiveCapabilities: {
    list: true,
    detail: true,
    open: false,
    comment: false,
    approve: false,
    merge: false,
    autoMerge: false,
  },
  effectiveMergeMethods: [],
  mergeMethodsSource: 'provider-default',
});

/** The state the fake forge reports for `owner/name#ref`; OPEN when unlisted. */
type Forge = {
  states: Record<string, string>;
  /** Pull requests whose provider answer names another repository. */
  renamed: Set<string>;
  /** Pull requests whose read throws. */
  failing: Set<string>;
  delayMs: number;
  /** Runs once inside the first provider read, before it answers. */
  onRead?: () => Promise<void>;
};

function fixture(forge: Partial<Forge> = {}) {
  const world: Forge = {
    states: {},
    renamed: new Set(),
    failing: new Set(),
    delayMs: 0,
    ...forge,
  };
  const reads: string[] = [];
  const getPullRequestByIdentity = vi.fn(
    async (
      context: PullRequestRepositoryIdentityContext,
      ref: string,
    ): Promise<PullRequestResult<PullRequest>> => {
      const key = `${context.repository.owner}/${context.repository.name}#${ref}`;
      reads.push(key);
      if (world.onRead) {
        const run = world.onRead;
        world.onRead = undefined;
        await run();
      }
      if (world.delayMs) await new Promise((r) => setTimeout(r, world.delayMs));
      if (world.failing.has(key)) throw new Error('forge down');
      return answer({
        provider: 'github',
        host: context.host,
        // A forge answering for a longer repository name than was asked.
        repository: world.renamed.has(key)
          ? { ...context.repository, name: `${context.repository.name}-2` }
          : context.repository,
        ref,
        nativeId: `native-${ref}`,
        url: 'https://github.com/o/r/pull/1',
        title: 'Title',
        body: null,
        state: world.states[key] ?? 'OPEN',
        author: { login: 'someone' },
        sourceBranch: 'feature',
        targetBranch: 'main',
        commits: 1,
        reviewStatus: 'NONE',
        comments: 0,
        mergeability: 'unknown',
      });
    },
  );
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    getPullRequestByIdentity,
  } as unknown as IPullRequestProvider;

  const home = makeTempDir('station-close-out-');
  const workspace = makeTempDir('station-close-out-workspace-');
  const graph = new TaskGraphService(home, {
    projectService: {
      getProject: (slug: string) => {
        if (slug !== 'project-alpha') throw new Error('missing project');
        return {
          id: slug,
          slug,
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        };
      },
    },
  });
  const closeOut = createTaskCloseOut({
    taskGraph: graph,
    providers: () => [provider],
  });
  const authorization = {
    expectedProjectId: 'project-alpha',
    isAuthorized: () => true,
  };
  return {
    world,
    reads,
    getPullRequestByIdentity,
    graph,
    closeOut,
    providers: () => [provider],
    storePath: join(home, 'task-graph.json'),
    /** A Task a person opted in, moved to `status`. */
    async task(status: TaskStatus = 'in_progress', id?: string, optIn = true) {
      const task = await graph.createTask(
        { projectId: 'project-alpha', title: 'Ship it' },
        undefined,
        id,
      );
      // The opt-in is a person's act on an open Task, so it comes first.
      if (optIn) await graph.setCloseOnMerge(task.id, true);
      if (status !== 'todo') {
        // `todo` reaches `in_progress`; the rest go on from there.
        await graph.updateTaskStatus(task.id, 'in_progress');
        if (status !== 'in_progress')
          await graph.updateTaskStatus(task.id, status);
      }
      return task;
    },
    keep(
      taskId: string,
      ref: string,
      repository = { owner: 'owner', name: 'repo' },
      sessionId = 'session-1',
      /** One turn's declarations all carry that turn's terminal event. */
      eventId = `event-${repository.name}-${ref}`,
    ) {
      return graph.keepDeclaredPullRequest(
        {
          taskId,
          operationId: `op-${repository.name}-${ref}-${sessionId}`,
          provider: 'github',
          host: 'github.com',
          repository,
          ref,
          nativeId: `native-${ref}`,
          provenance: {
            sessionId,
            turnId: `turn-${ref}`,
            toolCallId: `call-${ref}`,
            declarationId: `declaration-${ref}`,
            eventId,
          },
        },
        authorization,
      );
    },
    status: (taskId: string) => graph.readTask(taskId)?.status,
  };
}

describe('Task close-out on merge', () => {
  test('moves an opted-in Task to done once every kept pull request is merged', async () => {
    const f = fixture({
      states: { 'owner/repo#1': 'MERGED', 'owner/repo#2': 'MERGED' },
    });
    const task = await f.task();
    await f.keep(task.id, '1');
    await f.keep(task.id, '2');

    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('closed');
    expect(f.status(task.id)).toBe('done');
  });

  test('a pull request that was closed without merging does not complete the Task', async () => {
    const f = fixture({
      states: { 'owner/repo#1': 'MERGED', 'owner/repo#2': 'CLOSED' },
    });
    const task = await f.task();
    await f.keep(task.id, '1');
    await f.keep(task.id, '2');

    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
    expect(f.status(task.id)).toBe('in_progress');
  });

  test('a Task whose only kept pull request was closed unmerged stays open', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'CLOSED' } });
    const task = await f.task();
    await f.keep(task.id, '1');
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
    expect(f.status(task.id)).toBe('in_progress');
  });

  // Exactly the provider's MERGED completes. A state the code does not know,
  // or one that only resembles it, does not.
  test.each(['OPEN', 'CLOSED', 'LOCKED', 'DRAFT', 'merged', 'MERGED '])(
    'provider state %j does not complete the Task',
    async (state) => {
      const f = fixture({ states: { 'owner/repo#1': state } });
      const task = await f.task();
      await f.keep(task.id, '1');
      await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
      expect(f.status(task.id)).toBe('in_progress');
    },
  );

  test('a pull request the forge cannot be asked about does not complete the Task', async () => {
    const f = fixture({
      states: { 'owner/repo#1': 'MERGED', 'owner/repo#2': 'MERGED' },
      failing: new Set(['owner/repo#2']),
    });
    const task = await f.task();
    await f.keep(task.id, '1');
    await f.keep(task.id, '2');
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
    expect(f.status(task.id)).toBe('in_progress');
  });

  // The forge's own answer must be for the kept pull request: a MERGED
  // `owner/repo-2#1` is not a MERGED `owner/repo#1`.
  test('a merged pull request in owner/repo-2 is not owner/repo', async () => {
    const f = fixture({
      states: { 'owner/repo#1': 'MERGED' },
      renamed: new Set(['owner/repo#1']),
    });
    const task = await f.task();
    await f.keep(task.id, '1');
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
    expect(f.status(task.id)).toBe('in_progress');
  });

  test('a Task nobody opted in is never closed, whatever merged', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task('in_progress', undefined, false);
    await f.keep(task.id, '1');
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('not-applicable');
    expect(f.status(task.id)).toBe('in_progress');
    expect(f.reads).toEqual([]);
  });

  test('a Task with nothing kept is not closed: no pull requests is not all merged', async () => {
    const f = fixture();
    const task = await f.task();
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('not-applicable');
    expect(f.status(task.id)).toBe('in_progress');
  });

  test('a creation does not carry the opt-in, and a person can withdraw it', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task('in_progress', undefined, false);
    expect(f.graph.readTask(task.id)?.closeOnMerge).toBeUndefined();
    await f.graph.setCloseOnMerge(task.id, true);
    expect(f.graph.readTask(task.id)?.closeOnMerge).toBe(true);
    await f.keep(task.id, '1');
    await f.graph.setCloseOnMerge(task.id, false);
    expect(f.graph.readTask(task.id)?.closeOnMerge).toBeUndefined();
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('not-applicable');
    expect(f.status(task.id)).toBe('in_progress');
  });

  // `canTransitionTaskStatus`: `done` is not reachable from `todo`, and a
  // settled Task stays as it settled.
  test.each<[TaskStatus, string]>([
    ['todo', 'not-applicable'],
    ['done', 'not-applicable'],
    ['canceled', 'not-applicable'],
    ['review', 'closed'],
    ['verification', 'closed'],
  ])('a Task in %s: close-out answers %s', async (status, expected) => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task(status);
    await f.keep(task.id, '1');
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe(expected);
    expect(f.status(task.id)).toBe(expected === 'closed' ? 'done' : status);
  });

  test('a pull request kept after the observation blocks the close', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1');
    const plan = f.graph.readCloseOutPlan(task.id)!;
    // A person keeps another pull request while the reads were in flight.
    await f.keep(task.id, '2');
    await expect(
      f.graph.completeTaskOnMerge({
        taskId: task.id,
        taskCreatedAt: plan.taskCreatedAt,
        mergedKeeps: mergedOf(plan.keeps),
      }),
    ).resolves.toBe(false);
    expect(f.status(task.id)).toBe('in_progress');
  });

  // A stack of pull requests from one turn: every declaration shares that
  // turn's terminal event, so the event alone cannot tell them apart.
  test('a pull request kept from the same turn event during the reads blocks the close', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1', undefined, 'session-1', 'event-turn-1');
    const plan = f.graph.readCloseOutPlan(task.id)!;
    // A person keeps #2 (still open) from the same turn while the reads ran.
    await f.keep(task.id, '2', undefined, 'session-1', 'event-turn-1');
    await expect(
      f.graph.completeTaskOnMerge({
        taskId: task.id,
        taskCreatedAt: plan.taskCreatedAt,
        mergedKeeps: mergedOf(plan.keeps),
      }),
    ).resolves.toBe(false);
    expect(f.status(task.id)).toBe('in_progress');
  });

  test('refuses to reconcile more kept pull requests than it will read', async () => {
    const f = fixture();
    const task = await f.task();
    for (let ref = 1; ref <= 21; ref += 1) await f.keep(task.id, String(ref));
    await expect(f.closeOut.reconcile(task.id)).resolves.toBe('pending');
    expect(f.reads).toEqual([]);
  });

  describe('a recreated Task', () => {
    /**
     * Replace the Task with another under the same id, as a restored or reset
     * home can: its keeps go with it (the store refuses a keep whose Task is
     * absent), so the replacement starts with none of the old Task's.
     */
    async function recreate(f: ReturnType<typeof fixture>, id: string) {
      const stored = JSON.parse(readFileSync(f.storePath, 'utf8'));
      stored.tasks = stored.tasks.filter(
        (task: { id: string }) => task.id !== id,
      );
      stored.declaredPullRequestKeeps = stored.declaredPullRequestKeeps.filter(
        (keep: { taskId: string }) => keep.taskId !== id,
      );
      writeFileSync(f.storePath, JSON.stringify(stored));
      // A later timestamp: the new record is a different incarnation.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return f.task('in_progress', id);
    }

    // The provider reads take time. A Task replaced while they run is not
    // the Task whose pull requests were read, even when it kept the very
    // same pull request from the very same event.
    test('is not closed by pull requests read for the Task it replaced', async () => {
      const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
      const original = await f.task();
      await f.keep(original.id, '1');
      let replacementId: string | undefined;
      f.world.onRead = async () => {
        const replacement = await recreate(f, original.id);
        await f.keep(replacement.id, '1');
        replacementId = replacement.id;
      };

      await expect(f.closeOut.reconcile(original.id)).resolves.toBe('pending');
      expect(replacementId).toBe(original.id);
      expect(f.status(original.id)).toBe('in_progress');
      // Not even a later reconcile of the replacement is closed by that read:
      // it reads for itself, and the replacement closes on its own merits.
      f.world.onRead = undefined;
      await expect(f.closeOut.reconcile(original.id)).resolves.toBe('closed');
    });

    test('an observation of the old Task is not applied to the new one', async () => {
      const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
      const original = await f.task();
      await f.keep(original.id, '1');
      const plan = f.graph.readCloseOutPlan(original.id)!;
      const replacement = await recreate(f, original.id);
      await f.keep(replacement.id, '1');
      await expect(
        f.graph.completeTaskOnMerge({
          taskId: replacement.id,
          taskCreatedAt: plan.taskCreatedAt,
          mergedKeeps: mergedOf(plan.keeps),
        }),
      ).resolves.toBe(false);
      expect(f.status(replacement.id)).toBe('in_progress');
    });
  });
});

describe('Task close-out riding a refresh that observed a merge', () => {
  const merged = (name: string, ref: string) => ({
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'owner', name },
    ref,
  });

  test('reconciles the Tasks that kept an observed-merged pull request from the refreshed sessions', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1');

    f.closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
    await vi.waitFor(() => expect(f.status(task.id)).toBe('done'));
  });

  test('does nothing for a Task kept from another session', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1', undefined, 'session-other');

    f.closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.reads).toEqual([]);
    expect(f.status(task.id)).toBe('in_progress');
  });

  // Matched component by component: `repo-2` merging says nothing of `repo`.
  test('an observed merge in owner/repo-2 does not reconcile a Task that kept owner/repo', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1');

    f.closeOut.afterMergeObserved(['session-1'], [merged('repo-2', '1')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.reads).toEqual([]);
    expect(f.status(task.id)).toBe('in_progress');
  });

  test('one reconcile per Task at a time, however often a refresh repeats', async () => {
    const f = fixture({
      states: { 'owner/repo#1': 'MERGED' },
      delayMs: 40,
    });
    const task = await f.task();
    await f.keep(task.id, '1');

    f.closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
    f.closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
    f.closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
    await vi.waitFor(() => expect(f.status(task.id)).toBe('done'));
    expect(f.reads).toEqual(['owner/repo#1']);
  });

  // `completeTaskOnMerge` writes the store, so it can reject after the
  // refresh has long since answered: the detached reconcile owns that failure.
  test('a store write that rejects is reported, leaves the Task as it is, and does not strand the Task', async () => {
    const f = fixture({ states: { 'owner/repo#1': 'MERGED' } });
    const task = await f.task();
    await f.keep(task.id, '1');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let failing = true;
      const onError = vi.fn();
      const closeOut = createTaskCloseOut({
        taskGraph: {
          readCloseOutPlan: (id) => f.graph.readCloseOutPlan(id),
          listKeptDeclaredPullRequestsForSessions: (ids) =>
            f.graph.listKeptDeclaredPullRequestsForSessions(ids),
          completeTaskOnMerge: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (failing) throw new Error('store write failed');
            return f.graph.completeTaskOnMerge(input);
          },
        },
        providers: f.providers,
        onError,
      });
      closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(f.status(task.id)).toBe('in_progress');
      // The failed attempt released the Task: the next refresh closes it.
      failing = false;
      closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]);
      await vi.waitFor(() => expect(f.status(task.id)).toBe('done'));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('never throws and never waits, even when the store cannot be read', () => {
    const onError = vi.fn();
    const closeOut = createTaskCloseOut({
      taskGraph: {
        readCloseOutPlan: () => undefined,
        completeTaskOnMerge: async () => false,
        listKeptDeclaredPullRequestsForSessions: () => {
          throw new Error('store unreadable');
        },
      },
      providers: () => [],
      onError,
    });
    expect(
      closeOut.afterMergeObserved(['session-1'], [merged('repo', '1')]),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
