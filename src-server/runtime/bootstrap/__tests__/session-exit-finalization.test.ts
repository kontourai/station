import { createHash } from 'node:crypto';
import { ORCHESTRATION_SHUTDOWN_EXIT_REASON } from '@kontourai/monument/session-boundary';
import { describe, expect, test, vi } from 'vitest';
import {
  finalizeSessionExit,
  type SessionExitDetail,
} from '../session-exit-finalization.js';

const sessionId = 'claude-1-session-worktree-session';
// The provisioning service's name binding: sanitized id plus a 32-hex digest
// of the full id (`worktreeSessionSegment`), so the metadata passes
// `assertWorktreeMetadataSessionBinding` exactly as a real record does.
const segment = `${sessionId}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;

// The `session.started` record a worktree Session's start writes.
const detail: SessionExitDetail = {
  session: { lifecycleState: 'canceled', updatedAt: '2026-11-12T22:05:26Z' },
  events: [
    {
      method: 'session.started',
      sessionId,
      metadata: {
        worktree: {
          mode: 'worktree',
          repoPath: '/repo',
          path: `/repo-worktrees/${segment}`,
          branch: `station/${segment}`,
          baseRef: 'main',
          cleanupPolicy: 'cleanup',
          preserveOnFailure: true,
          createdAt: '2026-11-12T18:00:00Z',
        },
      },
    },
  ],
};

function deps() {
  return {
    readExitDetail: vi.fn(async () => detail),
    publishAgentFinished: vi.fn(async () => {}),
    finalizeWorktree: vi.fn(async () => 'removed'),
    warn: vi.fn(),
  };
}

describe('session exit finalization', () => {
  test('an ordinary exit finalizes the Session worktree', async () => {
    const d = deps();
    await finalizeSessionExit(
      { sessionId, provider: 'claude', reason: 'process_exit', exitCode: 0 },
      d,
    );
    expect(d.publishAgentFinished).toHaveBeenCalledOnce();
    expect(d.finalizeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        metadata: expect.objectContaining({ mode: 'worktree' }),
      }),
    );
    expect(d.warn).not.toHaveBeenCalled();
  });

  // A supervisor drain closes every Session with this reason while the
  // orchestration service is already shutting down. The conversation resumes
  // in the same worktree after restart, so nothing is finalized and the
  // refused read is never attempted (it logged "Orchestration event store is
  // closed." on every drain).
  test("Station's own shutdown exit neither reads, finalizes nor warns", async () => {
    const d = deps();
    d.readExitDetail.mockRejectedValue(
      new Error('Orchestration event store is closed.'),
    );
    await finalizeSessionExit(
      {
        sessionId,
        provider: 'claude',
        reason: ORCHESTRATION_SHUTDOWN_EXIT_REASON,
      },
      d,
    );
    expect(d.readExitDetail).not.toHaveBeenCalled();
    expect(d.publishAgentFinished).not.toHaveBeenCalled();
    expect(d.finalizeWorktree).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
  });

  test('a failed read on an ordinary exit is still reported', async () => {
    const d = deps();
    d.readExitDetail.mockRejectedValue(new Error('read failed'));
    await finalizeSessionExit({ sessionId, reason: 'process_exit' }, d);
    expect(d.warn).toHaveBeenCalledWith(
      'Failed to finalize worktree on session exit',
      { sessionId, error: 'read failed' },
    );
  });
});
