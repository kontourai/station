import type { Notification } from '@kontourai/station-contracts/notification';
import type {
  IndependentReviewReceipt,
  ReviewEvidenceAggregate,
} from '@kontourai/station-contracts/review-evidence';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type { StarterInspectionReference } from '@kontourai/station-contracts/starter-work';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ApprovalInboxObservation } from '../approvals/approval-inbox.js';

const APPROVAL_SOURCE = 'approval-inbox';
const APPROVAL_CATEGORY = 'approval-request';

export type StarterOwnerResolution =
  | {
      state: 'current';
      completion:
        | 'open'
        | 'resolved'
        | 'expired'
        | 'receipt-present'
        | 'running'
        | 'completed'
        | 'failed'
        | 'indeterminate';
    }
  | { state: 'missing' | 'stale' | 'unavailable' | 'not_verified' };

export type StarterOwnerCandidate =
  | { state: 'current'; reference: StarterInspectionReference }
  | { state: 'missing' | 'unavailable' };

export interface StarterOwnerAdapters {
  approvals: {
    list(): Promise<Notification[]>;
    observe(notification: Notification): ApprovalInboxObservation;
  };
  runs: {
    readRun(
      id: string,
      authority: SessionReadAuthority,
    ): Promise<RunSummary | null>;
  };
  reviews: {
    read(
      receiptId: string,
      projectSlug: string,
    ): Promise<IndependentReviewReceipt | null>;
    listAll(): Promise<ReviewEvidenceAggregate>;
  };
  authority: SessionReadAuthority;
}

function approvalOrder(left: Notification, right: Notification): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function schedulerCompletion(
  run: RunSummary,
): 'running' | 'completed' | 'failed' | 'indeterminate' {
  if (
    run.status === 'queued' ||
    run.status === 'starting' ||
    run.status === 'running' ||
    run.status === 'waiting_for_approval'
  )
    return 'running';
  if (run.status === 'completed') return 'completed';
  if (
    run.failureKind === 'unknown' ||
    run.metadata?.schedulerState === 'indeterminate'
  )
    return 'indeterminate';
  return 'failed';
}

/** Resolves only identities that their named Station owner currently confirms. */
export function createStarterOwnerAdapter(deps: StarterOwnerAdapters) {
  const approvalNotifications = async () =>
    (await deps.approvals.list()).filter(
      (notification) =>
        notification.source === APPROVAL_SOURCE &&
        notification.category === APPROVAL_CATEGORY,
    );

  return {
    async candidate(
      kind: 'approval' | 'receipt',
    ): Promise<StarterOwnerCandidate> {
      try {
        if (kind === 'approval') {
          const notification = (await approvalNotifications())
            .filter(
              (candidate) =>
                (candidate.status === 'pending' ||
                  candidate.status === 'delivered') &&
                deps.approvals.observe(candidate).state === 'open',
            )
            .sort(approvalOrder)[0];
          return notification
            ? {
                state: 'current',
                reference: { kind: 'approval', id: notification.id },
              }
            : { state: 'missing' };
        }
        const aggregate = await deps.reviews.listAll();
        const receipt = [...aggregate.receipts].sort(
          (left, right) =>
            right.completedAt.localeCompare(left.completedAt) ||
            left.target.projectSlug.localeCompare(right.target.projectSlug) ||
            left.receiptId.localeCompare(right.receiptId),
        )[0];
        if (receipt)
          return {
            state: 'current',
            reference: {
              kind: 'receipt',
              owner: 'independent-review',
              id: receipt.receiptId,
              projectSlug: receipt.target.projectSlug,
            },
          };
        return aggregate.unavailableProjects.length > 0
          ? { state: 'unavailable' }
          : { state: 'missing' };
      } catch {
        return { state: 'unavailable' };
      }
    },

    async resolve(
      reference: StarterInspectionReference,
    ): Promise<StarterOwnerResolution> {
      try {
        if (reference.kind === 'approval') {
          const notification = (await approvalNotifications()).find(
            (candidate) => candidate.id === reference.id,
          );
          if (!notification) return { state: 'missing' };
          const observation = deps.approvals.observe(notification);
          if (observation.state === 'open')
            return { state: 'current', completion: 'open' };
          if (observation.state === 'resolved')
            return { state: 'current', completion: 'resolved' };
          if (observation.state === 'expired')
            return { state: 'current', completion: 'expired' };
          return { state: observation.state };
        }
        if (reference.kind === 'receipt') {
          if (reference.owner === 'scheduler-run') {
            const run = await deps.runs.readRun(reference.id, deps.authority);
            if (!run) return { state: 'missing' };
            return run.source === 'schedule'
              ? { state: 'current', completion: schedulerCompletion(run) }
              : { state: 'stale' };
          }
          const receipt = await deps.reviews.read(
            reference.id,
            reference.projectSlug,
          );
          return receipt
            ? { state: 'current', completion: 'receipt-present' }
            : { state: 'missing' };
        }
        return { state: 'not_verified' };
      } catch {
        return { state: 'unavailable' };
      }
    },
  };
}

export type StarterOwnerAdapter = ReturnType<typeof createStarterOwnerAdapter>;
