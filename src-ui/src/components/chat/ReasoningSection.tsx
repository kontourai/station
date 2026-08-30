import { useId, useState } from 'react';

interface ReasoningSectionProps {
  content: string;
  fontSize: number;
  show: boolean;
  hasAnswerText: boolean;
}

type DisclosureIntent = 'automatic' | 'user-open' | 'user-closed';
type ExplicitIntent = Exclude<DisclosureIntent, 'automatic'>;

/**
 * A message is rendered by TWO ReasoningSection instances over its life: the
 * streaming one inside StreamingMessage, and the settled transcript row after
 * the turn ends. The first unmounts at that handoff, so component state alone
 * loses the reader's choice at exactly the moment the feature exists to serve
 * — open the reasoning to follow along, and it snaps shut when the turn
 * completes. Explicit choices therefore live here, keyed by the reasoning
 * text's hash, which is the one identity both instances share (no message id
 * reaches both call sites). Only explicit choices are stored, so the map holds
 * what a reader touched rather than every message; the cap bounds a long
 * session. Two messages with byte-identical reasoning share an entry — they
 * open together, which is harmless and rare.
 */
const EXPLICIT_INTENTS = new Map<number, ExplicitIntent>();
const MAX_REMEMBERED_INTENTS = 200;

function intentKey(content: string): number {
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0;
  }
  return hash;
}

function rememberIntent(key: number, intent: ExplicitIntent): void {
  if (EXPLICIT_INTENTS.size >= MAX_REMEMBERED_INTENTS) {
    const oldest = EXPLICIT_INTENTS.keys().next();
    if (!oldest.done) EXPLICIT_INTENTS.delete(oldest.value);
  }
  EXPLICIT_INTENTS.set(key, intent);
}

/** Test seam: the store outlives components by design. */
export function __resetReasoningDisclosureIntents(): void {
  EXPLICIT_INTENTS.clear();
}

/**
 * Words, counted so the summary stays honest for scripts without whitespace
 * boundaries — a 500-character Chinese chain is not "1 word", and that count
 * is the reader's only signal of how much is hidden.
 */
function countWords(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: string },
      ) => { segment(input: string): Iterable<{ isWordLike?: boolean }> };
    }
  ).Segmenter;
  if (Segmenter) {
    let count = 0;
    for (const segment of new Segmenter(undefined, {
      granularity: 'word',
    }).segment(trimmed)) {
      if (segment.isWordLike) count += 1;
    }
    return count;
  }
  return trimmed.match(/\S+/gu)?.length ?? 0;
}

export function ReasoningSection({
  content,
  fontSize,
  show,
  hasAnswerText,
}: ReasoningSectionProps) {
  const detailsId = useId();
  const summaryId = `${detailsId}-summary`;
  const key = intentKey(content);
  // Automatic mode follows streaming content. An explicit activation leaves
  // that mode for the rest of this message's life — including across the
  // streaming -> settled remount — so answer arrival never overrides a
  // reader's choice.
  const [intent, setIntent] = useState<DisclosureIntent>(
    () => EXPLICIT_INTENTS.get(key) ?? 'automatic',
  );

  if (!show) return null;

  const isOpen =
    intent === 'user-open' || (intent === 'automatic' && !hasAnswerText);
  const wordCount = countWords(content);
  const summary = `Reasoning · ${wordCount.toLocaleString()} ${
    wordCount === 1 ? 'word' : 'words'
  }`;

  return (
    <div
      className="reasoning-section"
      style={{
        margin: '0.5rem 0',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: '4px',
        fontSize: `${fontSize}px`,
      }}
    >
      <button
        type="button"
        id={summaryId}
        className="turn-provenance__summary"
        aria-expanded={isOpen}
        aria-controls={detailsId}
        onClick={() => {
          const next: ExplicitIntent = isOpen ? 'user-closed' : 'user-open';
          rememberIntent(key, next);
          setIntent(next);
        }}
      >
        <span>{summary}</span>
        <span className="turn-provenance__chevron" aria-hidden="true">
          {isOpen ? '⌄' : '›'}
        </span>
      </button>
      {isOpen && (
        <section
          id={detailsId}
          aria-labelledby={summaryId}
          style={{
            padding: '0.5rem',
            borderTop: '1px solid var(--color-border)',
            color: 'var(--text-secondary)',
            fontSize: '0.85em',
            fontStyle: 'italic',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
          }}
        >
          {content}
        </section>
      )}
    </div>
  );
}
