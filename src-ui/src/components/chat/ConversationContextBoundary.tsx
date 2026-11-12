import {
  type ConversationContextBoundaryTranscriptMarker,
  isSummaryContextBoundary,
} from '@kontourai/station-contracts/conversation-context-boundary';
import './ConversationHandoff.css';

/** A durable transcript fact. Pending intent is intentionally never rendered. */
export function ConversationContextBoundary({
  boundary,
}: {
  boundary: ConversationContextBoundaryTranscriptMarker;
}) {
  const empty = !boundary.priorTranscriptInjected;
  const summarized = isSummaryContextBoundary(boundary.policy);
  return (
    <section className="conversation-handoff-boundary">
      <strong>
        {summarized
          ? 'Context reset: continued from a summary'
          : empty
            ? 'Context reset: started fresh'
            : 'Context reset: continued from history'}
      </strong>
      <span>
        {summarized
          ? 'The agent sees a summary, without its tool state, approvals, attachments or earlier tool results. Messages above stay readable.'
          : empty
            ? 'The agent no longer sees messages above this line.'
            : 'The agent rebuilt its context from this chat.'}
      </span>
    </section>
  );
}
