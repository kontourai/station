import {
  type ConversationContextBoundaryTranscriptMarker,
  isSummaryContextBoundary,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type { TurnProvenanceEngine } from '@kontourai/station-contracts/turn-provenance';
import {
  engineSentenceName,
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
    ? engineSentenceName(previousEngine)
    : 'The agent';
  // A summary start (of the chat, or of its Task's state) and a history
  // start both give the engine a bounded read, never its memory back.
  const note = isSummaryContextBoundary(boundary.policy)
    ? `${engine} kept only a summary. You still see everything above.`
    : boundary.priorTranscriptInjected
      ? `${engine} started over and read recent messages from this chat.`
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
