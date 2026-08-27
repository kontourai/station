/**
 * Leaf module on purpose: entry-side components (ChatDockBody, the queued-
 * message rows) need only this predicate, while the full outboundQueue
 * machinery stays behind its dynamic import — a static import of the queue
 * from the entry graph cost ~4KB gzip (caught by the bundle ceiling).
 */
export const WORKSPACE_REFUSAL_PREFIX = 'Workspace refusal:';

export function isWorkspaceRefusedTurn(turn: {
  status: string;
  lastError?: string;
}): boolean {
  return (
    turn.status === 'failed' &&
    turn.lastError?.startsWith(WORKSPACE_REFUSAL_PREFIX) === true
  );
}
