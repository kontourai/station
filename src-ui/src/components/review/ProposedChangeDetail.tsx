import type { ProposedChange } from '@kontourai/station-contracts/proposed-change';
import { Button } from '../Button';
import './review-detail.css';

/**
 * The before/after read of one pending proposed change, with its two decision
 * controls. Extracted from `ReviewQueueView` (#2065) so the project-scoped
 * Review layout renders the exact component the retired global queue did —
 * the snapshots are the only place a reviewer can read what a change actually
 * does, and the attention inbox deliberately carries the decision without
 * them.
 */
export function ProposedChangeDetail({
  change,
  pending,
  onApprove,
  onReject,
}: {
  change: ProposedChange;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <section className="review-queue-detail" data-testid="review-queue-detail">
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">{change.contentKind}</p>
          <h3>{change.path}</h3>
          <p>
            {change.changeType} from {change.sourceRuntime} in session{' '}
            {change.sessionId}
          </p>
        </div>
        <div className="review-queue-detail__actions">
          <Button variant="secondary" disabled={pending} onClick={onApprove}>
            Approve
          </Button>
          <Button
            variant="danger-outline"
            disabled={pending}
            onClick={onReject}
          >
            Reject
          </Button>
        </div>
      </header>

      <div className="review-queue-detail__meta">
        <span>Project {change.projectId}</span>
        <span>Created {new Date(change.createdAt).toLocaleString()}</span>
        <span>Status {change.status}</span>
      </div>

      <div className="review-queue-diff" data-kind={change.contentKind}>
        <SnapshotPanel
          label="Before"
          content={change.baseSnapshot?.content ?? ''}
        />
        <SnapshotPanel
          label="After"
          content={change.proposedSnapshot?.content ?? ''}
        />
      </div>
    </section>
  );
}

function SnapshotPanel({ label, content }: { label: string; content: string }) {
  return (
    <div className="review-queue-diff__panel">
      <div className="review-queue-diff__label">{label}</div>
      <pre>{content || 'No snapshot content'}</pre>
    </div>
  );
}
