import type {
  TaskReviewArtifactRef,
  TaskReviewAuthor,
  TaskReviewEvidence,
  TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';

export interface ReviewIdentity {
  name: string;
  avatarUrl?: string;
  startedBy?: { name: string; avatarUrl?: string };
}
export type ReviewSendMode = 'send' | 'send-and-resolve';
export interface ReviewDeliveryActions {
  onSend?: (
    threadIds: readonly string[],
    mode: ReviewSendMode,
  ) => void | Promise<void>;
  onCopyForAgent?: (threadIds: readonly string[]) => void | Promise<void>;
  sending?: boolean;
  delivery?: { agentName: string; working: boolean };
}
export interface ReviewThreadActions extends ReviewDeliveryActions {
  draftScope: string;
  resolveAuthor: (author: TaskReviewAuthor) => ReviewIdentity;
  captureSrc?: (captureId: string) => string | undefined;
  onOpenCapture?: (captureId: string) => void;
  onOpenEvidence?: (evidence: TaskReviewEvidence) => void;
  onCopyLink?: (threadId: string) => void | Promise<void>;
  onReply: (threadId: string, body: string) => void | Promise<void>;
  onResolve: (threadId: string) => void | Promise<void>;
  onReopen: (threadId: string) => void | Promise<void>;
}

export function isReviewThreadSendable(
  thread: Pick<TaskReviewThreadView, 'state' | 'baseState' | 'pendingFollowUp'>,
) {
  return (
    thread.state !== 'outdated' &&
    (thread.baseState === 'open' ||
      thread.baseState === 'agent-replied' ||
      (thread.baseState === 'sent' && thread.pendingFollowUp))
  );
}

export function sameReviewArtifact(
  a: TaskReviewArtifactRef,
  b: TaskReviewArtifactRef,
) {
  return (
    a.kind === b.kind &&
    (a.kind === 'answer' && b.kind === 'answer'
      ? a.sessionId === b.sessionId && a.turnId === b.turnId
      : 'id' in a && 'id' in b && a.id === b.id)
  );
}
