import { describe, expect, test, vi } from 'vitest';
import { sessionWorkspaceDirectoryFor } from '../session-workspace-directory.js';

const SESSIONS = [
  {
    threadId: 'isolated',
    projectSlug: 'alpha',
    workspaceIsolation: {
      mode: 'worktree',
      path: '/wt/isolated',
      baseRef: 'main',
    },
  },
  { threadId: 'in-checkout', projectSlug: 'alpha' },
  {
    threadId: 'other-project',
    projectSlug: 'beta',
    workspaceIsolation: { mode: 'worktree', path: '/wt/beta', baseRef: 'main' },
  },
] as never;

function deps(readable: string[]) {
  return {
    canRead: vi.fn((thread: string) => readable.includes(thread)),
    listSessions: vi.fn(async () => SESSIONS),
  };
}

describe('which directory a file read for a session targets (#2476)', () => {
  test('a readable worktree session reads its worktree; one in the checkout reads the checkout', async () => {
    const d = deps(['isolated', 'in-checkout']);
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'isolated'),
    ).resolves.toBe('/wt/isolated');
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'in-checkout'),
    ).resolves.toBeUndefined();
  });

  test('a session the caller may not read is refused before anything is looked up', async () => {
    const d = deps([]);
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'isolated'),
    ).resolves.toBeNull();
    expect(d.listSessions).not.toHaveBeenCalled();
  });

  test('another project’s session, or an unknown one, is refused', async () => {
    const d = deps(['other-project', 'ghost']);
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'other-project'),
    ).resolves.toBeNull();
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'ghost'),
    ).resolves.toBeNull();
  });
});
