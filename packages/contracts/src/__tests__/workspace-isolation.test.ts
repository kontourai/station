import { describe, expect, test } from 'vitest';
import type {
  WorkspaceIsolationConfig,
  WorkspaceIsolationMetadata,
} from '../workspace-isolation.js';

describe('workspace isolation contract', () => {
  test('supports shared and worktree execution modes', () => {
    const shared: WorkspaceIsolationConfig = { mode: 'shared' };
    const isolated: WorkspaceIsolationConfig = {
      mode: 'worktree',
      policy: {
        branchPrefix: 'station/session',
        cleanupOnCompletion: true,
        preserveOnFailure: true,
        baseRef: 'HEAD',
      },
    };

    expect(shared.mode).toBe('shared');
    expect(isolated.policy?.branchPrefix).toBe('station/session');
  });

  test('captures session metadata for provisioned worktrees', () => {
    const metadata: WorkspaceIsolationMetadata = {
      mode: 'worktree',
      repoPath: '/repo',
      path: '/repo-worktrees/session-1',
      branch: 'station/session/session-1',
      baseRef: 'HEAD',
      cleanupPolicy: 'cleanup',
      preserveOnFailure: true,
      createdAt: '2026-05-03T00:00:00.000Z',
    };

    expect(metadata).toEqual(
      expect.objectContaining({
        mode: 'worktree',
        branch: 'station/session/session-1',
      }),
    );
  });
});
