import { ORCHESTRATION_SHUTDOWN_EXIT_REASON } from '@kontourai/monument/session-boundary';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import {
  sessionExitWorktreeMetadata,
  terminalWorktreeStateForExit,
  type WorktreeTerminalState,
} from '../../services/projects/worktree-provisioning-service.js';
import { errorMessage } from '../../utils/error-message.js';

/** The persisted Session read an exit is finalized from. */
export interface SessionExitDetail {
  session: { lifecycleState?: unknown; updatedAt: string };
  events: unknown[];
}

export interface SessionExitFinalizationDeps<
  Detail extends SessionExitDetail = SessionExitDetail,
> {
  readExitDetail(sessionId: string): Promise<Detail | null>;
  /** Publishes a Task room's agent-finished fact; a no-op without a room. */
  publishAgentFinished(input: {
    sessionId: string;
    provider: string;
    detail: Detail;
  }): Promise<void>;
  finalizeWorktree(exit: {
    metadata: WorktreeSessionMetadata;
    terminalState: WorktreeTerminalState;
    sessionId: string;
  }): Promise<unknown>;
  warn(message: string, fields: Record<string, unknown>): void;
}

/**
 * What a Session's `session.exited` settles: its Task room's agent-finished
 * fact and the worktree it owns.
 *
 * Station's own shutdown (a supervisor drain, a stop) is not the end of a
 * Session. Its exit (`ORCHESTRATION_SHUTDOWN_EXIT_REASON`) leaves the turn for
 * the next boot's interrupted-turn recovery, and the conversation continues
 * in the SAME worktree (`continuation_workspace_worktree_gone` refuses one
 * whose worktree was removed). Finalizing here would apply the exit cleanup
 * policy to a worktree the conversation still needs, and report the agent
 * finished as cancelled. It also could not run: shutdown has already stopped
 * the orchestration service, whose reads then refuse.
 */
export async function finalizeSessionExit<Detail extends SessionExitDetail>(
  event: {
    sessionId: string;
    provider?: string;
    reason?: string;
    exitCode?: number;
  },
  deps: SessionExitFinalizationDeps<Detail>,
): Promise<void> {
  if (event.reason === ORCHESTRATION_SHUTDOWN_EXIT_REASON) return;
  const { sessionId } = event;
  try {
    const detail = await deps.readExitDetail(sessionId);
    if (!detail) return;
    if (event.provider)
      await deps.publishAgentFinished({
        sessionId,
        provider: event.provider,
        detail,
      });
    const metadata = sessionExitWorktreeMetadata(detail.events, sessionId);
    if (!metadata) return;
    const terminalState = terminalWorktreeStateForExit({
      lifecycleState: detail.session.lifecycleState,
      exitCode: event.exitCode,
      events: detail.events,
    });
    await deps.finalizeWorktree({ metadata, terminalState, sessionId });
  } catch (error) {
    deps.warn('Failed to finalize worktree on session exit', {
      sessionId,
      error: errorMessage(error),
    });
  }
}
