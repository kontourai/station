/**
 * #4507: finishing a Task never destroys work in its worktree.
 *
 * Real git throughout: a real repository in a temp directory, the real
 * `WorktreeProvisioningService` creating the Task's worktree, the real Task
 * worktree store writer recording it, and the real `TaskGraphService` status
 * transition finalizing it.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../task-graph-service.js';
import { TaskWorktreeStore } from '../task-worktree-store.js';
import {
  type GitCommandRunner,
  WorktreeProvisioningService,
} from '../worktree-provisioning-service.js';

/** Finalization opens checked repository snapshots; slow on a loaded host. */
const FINALIZED = { timeout: 15_000, interval: 50 };

const makeTempDir = trackTempDirs();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Station Test',
      GIT_AUTHOR_EMAIL: 'test@station.invalid',
      GIT_COMMITTER_NAME: 'Station Test',
      GIT_COMMITTER_EMAIL: 'test@station.invalid',
    },
    windowsHide: true,
  });
}

async function fixture(options: { busy?: () => boolean } = {}) {
  const parent = realpathSync(makeTempDir('task-worktree-final-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  git(workspace, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(workspace, 'README.md'), 'project\n');
  git(workspace, 'add', 'README.md');
  git(workspace, 'commit', '--quiet', '-m', 'initial');
  const graph = new TaskGraphService(home, {
    resolveProjectWorkspace: () => workspace,
    ...(options.busy ? { isWorkspaceBusy: options.busy } : {}),
  });
  const task = await graph.createTask({
    projectId: 'project-alpha',
    title: 'Work in a worktree',
  });
  await graph.updateTaskStatus(task.id, 'in_progress');
  const { metadata: worktree } =
    await new WorktreeProvisioningService().provisionForTask({
      repoPath: workspace,
      taskId: task.id,
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
  await new TaskWorktreeStore(home).update(task.id, () => ({
    taskCreatedAt: task.createdAt,
    worktree,
  }));
  return { parent, home, workspace, graph, taskId: task.id, worktree };
}

function branchExists(repo: string, worktree: WorktreeSessionMetadata) {
  return git(repo, 'branch', '--list', worktree.branch).trim() !== '';
}

async function keptReason(graph: TaskGraphService, taskId: string) {
  return (await graph.readTaskForOpen(taskId))?.taskWorktree?.kept?.reason;
}

describe('a done Task keeps a worktree that holds work (#4507)', () => {
  test('a commit no remote has keeps the worktree and its branch', async () => {
    const f = await fixture();
    writeFileSync(join(f.worktree.path, 'feature.txt'), 'work\n');
    git(f.worktree.path, 'add', 'feature.txt');
    git(f.worktree.path, 'commit', '--quiet', '-m', 'unpushed work');

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(
      async () => expect(await keptReason(f.graph, f.taskId)).toBe('unpushed'),
      FINALIZED,
    );
    expect(existsSync(join(f.worktree.path, 'feature.txt'))).toBe(true);
    expect(branchExists(f.workspace, f.worktree)).toBe(true);
    expect(f.graph.readTaskWorktree(f.taskId)).toEqual(f.worktree);
  });

  test('an uncommitted file keeps the worktree', async () => {
    const f = await fixture();
    writeFileSync(join(f.worktree.path, 'draft.txt'), 'not committed\n');

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(
      async () =>
        expect(await keptReason(f.graph, f.taskId)).toBe('uncommitted'),
      FINALIZED,
    );
    expect(existsSync(join(f.worktree.path, 'draft.txt'))).toBe(true);
    expect(branchExists(f.workspace, f.worktree)).toBe(true);
  });

  test('a clean worktree whose commits are pushed is removed with its branch', async () => {
    const f = await fixture();
    const remote = join(f.parent, 'remote.git');
    git(f.parent, 'init', '--quiet', '--bare', remote);
    git(f.workspace, 'remote', 'add', 'origin', remote);
    writeFileSync(join(f.worktree.path, 'feature.txt'), 'work\n');
    git(f.worktree.path, 'add', 'feature.txt');
    git(f.worktree.path, 'commit', '--quiet', '-m', 'pushed work');
    git(f.worktree.path, 'push', '--quiet', 'origin', f.worktree.branch);

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(
      () => expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
      FINALIZED,
    );
    expect(existsSync(f.worktree.path)).toBe(false);
    expect(branchExists(f.workspace, f.worktree)).toBe(false);
  });

  test('a running turn in the worktree defers removal until it ends', async () => {
    let running = true;
    const f = await fixture({ busy: () => running });

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(
      async () =>
        expect(await keptReason(f.graph, f.taskId)).toBe('session-running'),
      FINALIZED,
    );
    expect(existsSync(f.worktree.path)).toBe(true);

    // The turn ends; the runtime retries deferred finalizations.
    running = false;
    await f.graph.retryDeferredTaskWorktreeFinalizations();
    await vi.waitFor(
      () => expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
      FINALIZED,
    );
    expect(existsSync(f.worktree.path)).toBe(false);
  });
});

describe('a deferred finalization survives a restart (#4507)', () => {
  test('the first retry after a restart finishes a finalization deferred before it', async () => {
    const f = await fixture({ busy: () => true });
    await f.graph.updateTaskStatus(f.taskId, 'done');
    await vi.waitFor(
      async () =>
        expect(await keptReason(f.graph, f.taskId)).toBe('session-running'),
      FINALIZED,
    );

    // Station restarts: a new service over the same home, no turn running.
    const restarted = new TaskGraphService(f.home, {
      resolveProjectWorkspace: () => f.workspace,
      isWorkspaceBusy: () => false,
    });
    await restarted.retryDeferredTaskWorktreeFinalizations();

    await vi.waitFor(
      () => expect(restarted.readTaskWorktree(f.taskId)).toBeUndefined(),
      FINALIZED,
    );
    expect(existsSync(f.worktree.path)).toBe(false);
  });
});

describe('a Task finished while its worktree store was unreadable (#4507)', () => {
  test('is finalized by the first retry once the store is repaired', async () => {
    const f = await fixture();
    const storePath = join(f.home, 'task-worktrees.json');
    const good = readFileSync(storePath, 'utf8');
    writeFileSync(storePath, 'not json');

    await f.graph.updateTaskStatus(f.taskId, 'done');
    // Nothing can be finalized, and a retry while it is unreadable does
    // nothing either.
    await f.graph.retryDeferredTaskWorktreeFinalizations();
    expect(existsSync(f.worktree.path)).toBe(true);

    // Repaired in place, no restart: the next retry (a turn ending) runs it.
    writeFileSync(storePath, good);
    await f.graph.retryDeferredTaskWorktreeFinalizations();
    await vi.waitFor(
      () => expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
      FINALIZED,
    );
    expect(existsSync(f.worktree.path)).toBe(false);
  });
});

describe('a Task whose recorded worktree is gone is not stuck (#4507)', () => {
  test('finishing it forgets the record and leaves its branch', async () => {
    const f = await fixture();
    writeFileSync(join(f.worktree.path, 'feature.txt'), 'work\n');
    git(f.worktree.path, 'add', 'feature.txt');
    git(f.worktree.path, 'commit', '--quiet', '-m', 'work on the branch');
    rmSync(f.worktree.path, { recursive: true, force: true });

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(
      () => expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
      FINALIZED,
    );
    expect(branchExists(f.workspace, f.worktree)).toBe(true);
  });

  test('recovering it leaves other worktrees’ records alone, even with their folder missing', async () => {
    const f = await fixture();
    // Another checkout of the repository whose folder is away for now (an
    // unmounted volume, a move in progress).
    const other = join(f.parent, 'other-worktree');
    git(f.workspace, 'worktree', 'add', '--quiet', '-b', 'other', other);
    renameSync(other, `${other}-away`);
    rmSync(f.worktree.path, { recursive: true, force: true });

    await new WorktreeProvisioningService().provisionForTask({
      repoPath: f.workspace,
      taskId: f.taskId,
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
      recorded: f.worktree,
    });

    expect(existsSync(f.worktree.path)).toBe(true);
    expect(git(f.workspace, 'worktree', 'list', '--porcelain')).toContain(
      `worktree ${other}\n`,
    );
    // Back in place, the other checkout is still a working worktree.
    renameSync(`${other}-away`, other);
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'other',
    );
  });

  test('a registration of its branch at another, missing folder is forgotten, with relative worktree paths', async () => {
    const f = await fixture();
    git(f.workspace, 'config', 'worktree.useRelativePaths', 'true');
    // The Task's checkout was moved elsewhere, and that folder is gone too.
    const moved = join(f.parent, 'moved-away');
    git(f.workspace, 'worktree', 'move', f.worktree.path, moved);
    rmSync(moved, { recursive: true, force: true });

    const again = await new WorktreeProvisioningService().provisionForTask({
      repoPath: f.workspace,
      taskId: f.taskId,
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
      recorded: f.worktree,
    });

    expect(again.metadata.path).toBe(f.worktree.path);
    expect(existsSync(f.worktree.path)).toBe(true);
    expect(git(f.workspace, 'worktree', 'list', '--porcelain')).not.toContain(
      `worktree ${moved}\n`,
    );
  });

  test('provisioning it again checks its own branch out at the same place', async () => {
    const f = await fixture();
    writeFileSync(join(f.worktree.path, 'feature.txt'), 'work\n');
    git(f.worktree.path, 'add', 'feature.txt');
    git(f.worktree.path, 'commit', '--quiet', '-m', 'work on the branch');
    rmSync(f.worktree.path, { recursive: true, force: true });

    const again = await new WorktreeProvisioningService().provisionForTask({
      repoPath: f.workspace,
      taskId: f.taskId,
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
      recorded: f.worktree,
    });

    expect(again.provenance).toBe('created');
    expect(again.metadata).toMatchObject({
      path: f.worktree.path,
      branch: f.worktree.branch,
    });
    // The branch's committed work is back in the checkout.
    expect(existsSync(join(f.worktree.path, 'feature.txt'))).toBe(true);
  });
});

/** Settles with `pending`'s outcome, or 'still waiting' after `ms`. */
function within<T>(pending: Promise<T>, ms: number) {
  return Promise.race([
    pending.then(
      (value) => ({ settled: 'resolved' as const, value }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    ),
    new Promise<{ settled: 'still waiting' }>((resolve) =>
      setTimeout(() => resolve({ settled: 'still waiting' }), ms),
    ),
  ]);
}

describe('a hung git command holds nothing up (#4507)', () => {
  test('provisioning gives up on a git command that never ends, and the next one in the repository runs', async () => {
    const f = await fixture();
    const hung: GitCommandRunner = { run: () => new Promise(() => {}) };
    // Opening the repository answers at once, so the only thing that can
    // run out of time is the git command itself.
    const opened = async () =>
      ({
        top: f.workspace,
        repoArgs: [],
        env: process.env,
        dispose: async () => {},
      }) as never;
    const service = new WorktreeProvisioningService(hung, opened, {
      commandTimeoutMs: 100,
    });
    const request = (taskId: string) =>
      service.provisionForTask({
        repoPath: f.workspace,
        taskId,
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      });

    const first = await within(request('task-hung-1'), 5_000);
    const second = await within(request('task-hung-2'), 5_000);

    expect(first).toMatchObject({ settled: 'rejected' });
    expect(String((first as { error: unknown }).error)).toMatch(
      /git rev-parse did not finish within 100 ms/,
    );
    // Queued behind the first in the same repository, and still answered.
    expect(second).toMatchObject({ settled: 'rejected' });
  });

  test('a status change answers while its worktree finalization is still running', async () => {
    const parent = realpathSync(makeTempDir('task-worktree-hung-'));
    const home = join(parent, 'home');
    const workspace = join(parent, 'repo');
    mkdirSync(home);
    mkdirSync(workspace);
    git(workspace, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(workspace, 'README.md'), 'project\n');
    git(workspace, 'add', 'README.md');
    git(workspace, 'commit', '--quiet', '-m', 'initial');
    const real = new WorktreeProvisioningService();
    let finalizing = false;
    const graph = new TaskGraphService(home, {
      resolveProjectWorkspace: () => workspace,
      worktreeProvisioning: {
        provisionForTask: (request) => real.provisionForTask(request),
        finalizeForTask: () => {
          finalizing = true;
          return new Promise(() => {});
        },
      },
    });
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Finish while git hangs',
    });
    await graph.updateTaskStatus(task.id, 'in_progress');
    const { metadata: worktree } = await real.provisionForTask({
      repoPath: workspace,
      taskId: task.id,
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    await new TaskWorktreeStore(home).update(task.id, () => ({
      taskCreatedAt: task.createdAt,
      worktree,
    }));

    const answered = await within(
      graph.updateTaskStatus(task.id, 'done'),
      3_000,
    );

    expect(answered).toMatchObject({
      settled: 'resolved',
      value: { status: 'done' },
    });
    await vi.waitFor(() => expect(finalizing).toBe(true));
  });
});
