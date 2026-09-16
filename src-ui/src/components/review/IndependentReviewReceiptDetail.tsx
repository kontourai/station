import type { IndependentReviewReceipt } from '@kontourai/station-contracts/review-evidence';
import { useEffect, useRef } from 'react';
import './review-detail.css';

/**
 * #2064 (D4): one independent-review receipt, extracted verbatim from
 * `ReviewQueueView` so the Coding layout and the Review page render the same
 * evidence with the same input-only framing. The incomplete-evidence branch
 * is the load-bearing part: no findings is only "clean" when every reviewer
 * completed, and a second copy of this component is how that distinction
 * quietly stops being made on one of the two surfaces.
 */
export function IndependentReviewReceiptDetail({
  receipt,
  focused = false,
}: {
  receipt: IndependentReviewReceipt;
  focused?: boolean;
}) {
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) detailRef.current?.focus();
  }, [focused]);
  return (
    <section
      ref={detailRef}
      className="review-queue-detail"
      data-testid="independent-review-receipt-detail"
      tabIndex={focused ? -1 : undefined}
    >
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">
            Independent review evidence · input only
          </p>
          <h3>{receipt.target.projectSlug}</h3>
          <p>
            {receipt.target.baseSha.slice(0, 12)} →{' '}
            {receipt.target.headSha.slice(0, 12)}
          </p>
        </div>
      </header>
      <div className="review-queue-detail__meta">
        <span>{receipt.executions.length} reviewers</span>
        <span>{receipt.findings.length} findings</span>
        <span>{new Date(receipt.completedAt).toLocaleString()}</span>
      </div>
      <p>
        These findings are reviewer-authored evidence for verification. This
        receipt does not approve, reject, or satisfy a gate.
      </p>
      <section aria-label="Reviewer execution status">
        <h3>Reviewer execution</h3>
        <ul>
          {receipt.executions.map((execution) => (
            <li key={execution.reviewerId}>
              {execution.actor.displayName ?? execution.actor.actorId}:{' '}
              {execution.status}
              {execution.failureReason ? ` — ${execution.failureReason}` : ''}
            </li>
          ))}
        </ul>
      </section>
      {receipt.findings.length === 0 &&
      receipt.executions.every(
        (execution) => execution.status === 'completed',
      ) ? (
        <p>All reviewers completed; no concrete findings were recorded.</p>
      ) : receipt.findings.length === 0 ? (
        <p>
          Review evidence is incomplete. No findings can be interpreted as a
          clean review until every reviewer completes successfully.
        </p>
      ) : (
        receipt.findings.map((finding) => (
          <article
            className="review-comment-detail__body"
            key={finding.findingId}
          >
            <h3>{finding.summary}</h3>
            <p>
              {finding.location.file}:{finding.location.line} ·{' '}
              {finding.severity} · {finding.confidence} confidence ·{' '}
              {finding.basis}
            </p>
            <p>
              <strong>Trigger:</strong> {finding.scenario.stateOrInput}
            </p>
            <p>
              <strong>Wrong outcome:</strong> {finding.scenario.wrongOutcome}
            </p>
          </article>
        ))
      )}
    </section>
  );
}
