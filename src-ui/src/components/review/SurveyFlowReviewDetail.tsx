import type { SurveyFlowReviewItemVM } from '@kontourai/station-sdk';
import './review-detail.css';

/**
 * One paused Survey gate review session, rendered from the canonical Survey
 * state Station composes through `SurveyFlowReviewService` — its items, their
 * status labels, and each item's candidates with role and source.
 *
 * Extracted from `ReviewQueueView` (#2065). This is the workbench content D4
 * moves into the Review layout kind: the attention inbox carries only the
 * count and the link, because a decision on a gate item needs the candidate
 * set beside it.
 */
export function SurveyFlowReviewDetail({
  review,
}: {
  review: SurveyFlowReviewItemVM;
}) {
  return (
    <section
      className="review-queue-detail"
      data-testid="survey-flow-review-detail"
    >
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">Survey Flow gate</p>
          <h3>{review.sessionName}</h3>
          <p>{review.workflowSubjectRef}</p>
        </div>
      </header>
      <div className="review-queue-detail__meta">
        <span>Project {review.projectSlug}</span>
        {/* #2064 review MED-2: what the run is waiting for. `summary.unresolved`
            reads 0 for a session whose remaining items are all escalated. */}
        <span>{review.pendingDecisions} awaiting a decision</span>
        <span>Source {review.projectionSource}</span>
      </div>
      {review.items.map((item) => (
        <article className="review-comment-detail__body" key={item.target}>
          <h3>{item.targetLabel}</h3>
          <p>{item.statusLabel}</p>
          <ul>
            {item.candidates.map((candidate) => (
              <li key={`${candidate.roleLabel}:${candidate.valueText}`}>
                {candidate.roleLabel}: {candidate.valueText} ·{' '}
                {candidate.sourceText}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
