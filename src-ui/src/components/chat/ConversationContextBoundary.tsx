import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import './ConversationHandoff.css';

/** A durable transcript fact. Pending intent is intentionally never rendered. */
export function ConversationContextBoundary({
  boundary,
}: {
  boundary: ConversationContextBoundaryTranscriptMarker;
}) {
  const empty = !boundary.priorTranscriptInjected;
  return (
    <section
      className="conversation-handoff-boundary"
      aria-label={
        empty
          ? 'Next engine context started without prior transcript'
          : 'Next engine context re-anchored from prior transcript'
      }
    >
      <strong>
        {empty
          ? 'Next engine context started empty'
          : 'Next engine context re-anchored from durable history'}
      </strong>
      <span>
        {empty
          ? 'Prior transcript was not injected. The readable transcript, Task links, and evidence remain preserved.'
          : 'Prior transcript was re-anchored into this engine context. The readable transcript, Task links, and evidence remain preserved.'}
      </span>
    </section>
  );
}
