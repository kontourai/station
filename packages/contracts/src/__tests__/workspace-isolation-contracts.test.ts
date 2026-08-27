import { describe, expect, test } from 'vitest';
import type { AgentExecutionConfig } from '../agent.js';
import { engineConnectionId } from '../agent-identity.js';
import type {
  WorkspaceIsolationConfig,
  WorkspaceIsolationMetadata,
} from '../workspace-isolation.js';

describe('workspace isolation contracts', () => {
  test('extends agent execution config with shared and worktree isolation modes', () => {
    const shared: WorkspaceIsolationConfig = { mode: 'shared' };
    const worktree: AgentExecutionConfig = {
      agentConnectionId: engineConnectionId('codex'),
      modelConnectionId: 'codex-model',
      workspaceIsolationMode: 'worktree',
      workspaceIsolation: {
        mode: 'worktree',
        policy: {
          branchPrefix: 'station/session',
          cleanupOnCompletion: true,
          preserveOnFailure: true,
        },
      },
    };

    expect(shared.mode).toBe('shared');
    expect(worktree.workspaceIsolationMode).toBe('worktree');
    expect(worktree.workspaceIsolation?.policy?.branchPrefix).toBe(
      'station/session',
    );
  });

  test('describes provisioned worktree session metadata', () => {
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
        cleanupPolicy: 'cleanup',
      }),
    );
  });
});
