import { EXTENSION_TRANSCRIPT_MARKER_PART_TYPE } from '@kontourai/station-shared/extension-transcript-markers';
import './TranscriptMarker.css';

/**
 * The label of a projected marker row, or undefined for any other row. Every
 * transcript surface asks this one question, so a marker never falls through
 * to a speaker row with no text in it.
 */
export function transcriptMarkerLabel(
  contentParts: ReadonlyArray<{ type: string; content?: string }> | undefined,
): string | undefined {
  return contentParts?.find(
    (part) => part.type === EXTENSION_TRANSCRIPT_MARKER_PART_TYPE,
  )?.content;
}

/**
 * station#3415: a quiet line in the transcript for an engine fact that is not
 * a message — a context compaction, a rewind to an earlier prompt. The label
 * comes from the projection's fixed table (`extension-transcript-markers.ts`),
 * never from engine payload text.
 */
export function TranscriptMarker({
  label,
  anchorKey,
}: {
  label: string;
  anchorKey?: string;
}) {
  // Plain text between two drawn rules: a screen reader reads the label in
  // its place in the transcript, and the rules are decoration only.
  return (
    <p className="transcript-marker" data-chat-message-key={anchorKey}>
      <span className="transcript-marker__rule" aria-hidden="true" />
      <span className="transcript-marker__label">{label}</span>
      <span className="transcript-marker__rule" aria-hidden="true" />
    </p>
  );
}
