import { describe, expect, test, vi } from 'vitest';
import {
  pullRequestSessionForReader,
  pullRequestThreadForProject,
} from '../runtime-routes.js';

describe('pull request thread context', () => {
  test('does not select a cross-project thread to override a pull request checkout', () => {
    const foreignThread = {
      threadId: 'thread-from-project-y',
      projectSlug: 'project-y',
      workspaceIsolation: { path: '/project-y-worktree' },
    };
    const localThread = {
      threadId: 'thread-from-project-x',
      projectSlug: 'project-x',
      workspaceIsolation: { path: '/project-x-worktree' },
    };

    expect(
      pullRequestThreadForProject(
        [foreignThread, localThread],
        foreignThread.threadId,
        'project-x',
      ),
    ).toBeUndefined();
    expect(
      pullRequestThreadForProject(
        [foreignThread, localThread],
        localThread.threadId,
        'project-x',
      ),
    ).toBe(localThread);
  });
});

describe('a pull-request request naming a session (#2476 review L4)', () => {
  const sessions = [
    {
      threadId: 'mine',
      projectSlug: 'project-x',
      workspaceIsolation: { path: '/wt' },
    },
  ];
  test('a session the caller may not read is refused before anything is listed', async () => {
    const listSessions = vi.fn(async () => sessions);
    await expect(
      pullRequestSessionForReader(
        { canRead: () => false, listSessions },
        'mine',
        'project-x',
      ),
    ).resolves.toBe('refused');
    expect(listSessions).not.toHaveBeenCalled();
  });

  test('a readable session of the project is used; no thread means none', async () => {
    const deps = { canRead: () => true, listSessions: async () => sessions };
    await expect(
      pullRequestSessionForReader(deps, 'mine', 'project-x'),
    ).resolves.toBe(sessions[0]);
    await expect(
      pullRequestSessionForReader(deps, undefined, 'project-x'),
    ).resolves.toBeUndefined();
    await expect(
      pullRequestSessionForReader(deps, 'mine', 'project-y'),
    ).resolves.toBeUndefined();
  });
});
