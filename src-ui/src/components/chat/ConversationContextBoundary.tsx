import {
  type ConversationContextBoundaryTranscriptMarker,
  isSummaryContextBoundary,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  type TurnProvenanceEngine,
  turnProvenanceEngineLabel,
} from '@kontourai/station-contracts/turn-provenance';
import {
  FreshContextGlyph,
  TranscriptChangeMarker,
} from './TranscriptChangeMarker';

/**
 * A durable transcript fact (chat-24 "fresh context"): the engine stays, its
 * memory does not. Pending intent is intentionally never rendered. The engine
 * is the one the last recorded turn before the boundary ran on; without that
 * record the line names "The agent" instead of guessing.
 */
export function ConversationContextBoundary({
  boundary,
  previousEngine,
}: {
  boundary: ConversationContextBoundaryTranscriptMarker;
  previousEngine?: TurnProvenanceEngine;
}) {
  const engine = previousEngine
    ? turnProvenanceEngineLabel(previousEngine)
    : 'The agent';
  const note = isSummaryContextBoundary(boundary.policy)
    ? `${engine} kept only a summary of everything above. You still see it.`
    : boundary.priorTranscriptInjected
      ? `${engine} rebuilt its memory from this chat.`
      : `${engine} forgot everything above. You still see it.`;
  return (
    <TranscriptChangeMarker
      kind="context"
      pill={
        <>
          <FreshContextGlyph />
          Fresh context
        </>
      }
      note={note}
    />
  );
}
