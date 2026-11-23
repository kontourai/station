import type { ReactNode } from 'react';
import { modelIdentityLabel } from '../../utils/modelCapabilities';
import { glyph } from '../icons/Glyph';
import type { TranscriptModelChange } from './transcriptChangeMarkers';
import './TranscriptChangeMarker.css';

/** The eraser on the fresh-context pill (chat-24). */
export const FreshContextGlyph = /* @__PURE__ */ glyph(
  'M6.5 13.5h7M2.9 9.6l5.7-6.2a1.4 1.4 0 0 1 2 0l2.1 2.1a1.4 1.4 0 0 1 0 2L7.6 13.5H5.2L2.9 11.2a1.1 1.1 0 0 1 0-1.6ZM5.4 6.9l3.9 3.9',
);

/**
 * chat-24: one row in the transcript that says what changed between two
 * stretches of a chat — a model change, a fresh context or an engine switch.
 * The pill names the change and the line under it says what the agent kept.
 * It is text in reading order, not a control: the rules are decoration.
 */
export function TranscriptChangeMarker({
  kind,
  pill,
  note,
  label,
  children,
}: {
  kind: 'model' | 'context' | 'engine';
  pill: ReactNode;
  note?: ReactNode;
  /** A landmark name, for the one marker that carries more than its text. */
  label?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="transcript-change__line">
        <span className="transcript-change__rule" aria-hidden="true" />
        <span className="transcript-change__pill">{pill}</span>
        <span className="transcript-change__rule" aria-hidden="true" />
      </div>
      {note ? <p className="transcript-change__note">{note}</p> : null}
      {children}
    </>
  );
  const className = `transcript-change transcript-change--${kind}`;
  return label ? (
    <section className={className} aria-label={label}>
      {body}
    </section>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** "→" for the eye, "to" for a screen reader. */
export function ChangeArrow() {
  return (
    <>
      <span aria-hidden="true">{' → '}</span>
      <span className="sr-only"> to </span>
    </>
  );
}

export function ModelChangeMarker({
  change,
}: {
  change: TranscriptModelChange;
}) {
  return (
    <TranscriptChangeMarker
      kind="model"
      pill={
        <>
          {`Model: ${modelIdentityLabel(change.from)}`}
          <ChangeArrow />
          {modelIdentityLabel(change.to)}
        </>
      }
      note="Same engine, same memory."
    />
  );
}
