import { describe, expect, test } from 'vitest';
import { pullRequestThreadForProject } from '../runtime-routes.js';

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
