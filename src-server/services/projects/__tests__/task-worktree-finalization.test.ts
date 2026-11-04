/**
 * #4507: finishing a Task never destroys work in its worktree.
 *
 * Real git throughout: a real repository in a temp directory, the real
 * `WorktreeProvisioningService` creating the Task's worktree, the real Task
 * worktree store writer recording it, and the real `TaskGraphService` status
 * transition finalizing it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../task-graph-service.js';
import { TaskWorktreeStore } from '../task-worktree-store.js';
import { WorktreeProvisioningService } from '../worktree-provisioning-service.js';

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

    await vi.waitFor(async () =>
      expect(await keptReason(f.graph, f.taskId)).toBe('unpushed'),
    );
    expect(existsSync(join(f.worktree.path, 'feature.txt'))).toBe(true);
    expect(branchExists(f.workspace, f.worktree)).toBe(true);
    expect(f.graph.readTaskWorktree(f.taskId)).toEqual(f.worktree);
  });

  test('an uncommitted file keeps the worktree', async () => {
    const f = await fixture();
    writeFileSync(join(f.worktree.path, 'draft.txt'), 'not committed\n');

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(async () =>
      expect(await keptReason(f.graph, f.taskId)).toBe('uncommitted'),
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

    await vi.waitFor(() =>
      expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
    );
    expect(existsSync(f.worktree.path)).toBe(false);
    expect(branchExists(f.workspace, f.worktree)).toBe(false);
  });

  test('a running turn in the worktree defers removal until it ends', async () => {
    let running = true;
    const f = await fixture({ busy: () => running });

    await f.graph.updateTaskStatus(f.taskId, 'done');

    await vi.waitFor(async () =>
      expect(await keptReason(f.graph, f.taskId)).toBe('session-running'),
    );
    expect(existsSync(f.worktree.path)).toBe(true);

    // The turn ends; the runtime retries deferred finalizations.
    running = false;
    await f.graph.retryDeferredTaskWorktreeFinalizations();
    await vi.waitFor(() =>
      expect(f.graph.readTaskWorktree(f.taskId)).toBeUndefined(),
    );
    expect(existsSync(f.worktree.path)).toBe(false);
  });
});
