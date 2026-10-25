import type {
  TaskReviewAuthor,
  TaskReviewEvidence,
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
