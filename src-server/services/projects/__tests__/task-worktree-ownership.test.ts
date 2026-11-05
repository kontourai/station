/**
 * #4507: a Task-owned worktree belongs to its Task, never to a Session.
 *
 * Metadata here is what the real provisioning writes, against a real git
 * repository: a Session's own worktree (`provision`) and a Task's
 * (`provisionForTask`).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  TASK_WORKTREE_STORE_FILE,
  TaskWorktreeStore,
} from '../task-worktree-store.js';
import {
  assertWorktreeMetadataSessionBinding,
  sessionExitWorktreeMetadata,
  WorktreeProvisioningService,
} from '../worktree-provisioning-service.js';

const makeTempDir = trackTempDirs();

function repository() {
  const parent = realpathSync(makeTempDir('task-worktree-owner-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Station Test',
        GIT_AUTHOR_EMAIL: 'test@station.invalid',
        GIT_COMMITTER_NAME: 'Station Test',
        GIT_COMMITTER_EMAIL: 'test@station.invalid',
      },
      windowsHide: true,
    });
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
  return { parent, repo };
}

function started(sessionId: string, worktree: unknown) {
  return [
    {
      method: 'session.started',
      sessionId,
      metadata: { projectSlug: 'project-alpha', worktree },
    },
  ];
}

describe('Task-owned worktrees and Sessions (#4507)', () => {
  test('a Session exit finalizes its own worktree but never a Task’s', async () => {
    const { repo } = repository();
    const service = new WorktreeProvisioningService();
    const own = await service.provision({
      repoPath: repo,
      threadId: 'session-own',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    const { metadata: taskOwned } = await service.provisionForTask({
      repoPath: repo,
      taskId: 'task-1',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });

    expect(
      sessionExitWorktreeMetadata(started('session-own', own), 'session-own'),
    ).toEqual(own);
    expect(
      sessionExitWorktreeMetadata(
        started('session-of-task', taskOwned),
        'session-of-task',
      ),
    ).toBeUndefined();
  });

  test('no Session can claim a Task-owned worktree, even one named for it', async () => {
    const { repo } = repository();
    const service = new WorktreeProvisioningService();
    const own = await service.provision({
      repoPath: repo,
      threadId: 'session-x',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    // The same checkout, its names bound to session-x, marked Task-owned.
    const marked = { ...own!, owner: { kind: 'task' as const, taskId: 't' } };

    expect(() =>
      assertWorktreeMetadataSessionBinding(marked, 'session-x'),
    ).toThrow('not bound to its session');
    await expect(
      service.cleanup({
        metadata: marked,
        terminalState: 'completed',
        sessionId: 'session-x',
      }),
    ).rejects.toThrow('not bound to its session');
    expect(existsSync(own!.path)).toBe(true);
  });

  test('a stored record naming another Task is ignored, and the rest stay readable', async () => {
    const { parent, repo } = repository();
    const home = join(parent, 'home');
    mkdirSync(home);
    const { metadata } =
      await new WorktreeProvisioningService().provisionForTask({
        repoPath: repo,
        taskId: 'task-a',
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      });
    const store = new TaskWorktreeStore(home);
    const createdAt = '2026-11-04T00:00:00.000Z';
    await store.update('task-a', () => ({
      taskCreatedAt: createdAt,
      worktree: metadata,
    }));
    // Task B's entry is a transplant of Task A's record.
    const path = join(home, TASK_WORKTREE_STORE_FILE);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.entries['task-b'] = structuredClone(data.entries['task-a']);
    writeFileSync(path, JSON.stringify(data));

    expect(store.read('task-b', createdAt)).toBeUndefined();
    expect(store.read('task-a', createdAt)?.worktree).toEqual(metadata);
    expect(store.list().map((item) => item.taskId)).toEqual(['task-a']);
  });
});
