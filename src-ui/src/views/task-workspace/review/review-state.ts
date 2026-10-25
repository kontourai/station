import {
  deriveOutdated,
  deriveThreadState,
  type TaskReviewAuthor,
  type TaskReviewCurrentArtifact,
  type TaskReviewFilter,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';

export interface ReviewIdentity {
  name: string;
  avatarUrl?: string;
  startedBy?: { name: string; avatarUrl?: string };
}

export interface ReviewThreadActions {
  resolveAuthor: (author: TaskReviewAuthor) => ReviewIdentity;
  captureSrc?: (captureId: string) => string | undefined;
  onOpenCapture?: (captureId: string) => void;
  onReply: (threadId: string, body: string) => void | Promise<void>;
  onResolve: (threadId: string) => void | Promise<void>;
  onReopen: (threadId: string) => void | Promise<void>;
}

export function reviewThreadState(
  thread: TaskReviewThreadView,
  current: TaskReviewCurrentArtifact,
) {
  const base = deriveThreadState(thread.events);
  const outdated = deriveOutdated(thread, current);
  const filter: TaskReviewFilter =
    base === 'resolved' ? 'resolved' : outdated === true ? 'outdated' : 'open';
  return { base, outdated, filter };
}
