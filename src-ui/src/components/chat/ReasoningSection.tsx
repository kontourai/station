import { useId, useState } from 'react';

interface ReasoningSectionProps {
  content: string;
  fontSize: number;
  show: boolean;
  hasAnswerText: boolean;
}

type DisclosureIntent = 'automatic' | 'user-open' | 'user-closed';

export function ReasoningSection({
  content,
  fontSize,
  show,
  hasAnswerText,
}: ReasoningSectionProps) {
  const detailsId = useId();
  const summaryId = `${detailsId}-summary`;
  // Automatic mode follows streaming content. The first activation leaves
  // that mode permanently for this message, so answer arrival cannot
  // override an explicit reader choice.
  const [intent, setIntent] = useState<DisclosureIntent>('automatic');

  if (!show) return null;

  const isOpen =
    intent === 'user-open' || (intent === 'automatic' && !hasAnswerText);
  const wordCount = content.trim().match(/\S+/gu)?.length ?? 0;
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
        onClick={() => setIntent(isOpen ? 'user-closed' : 'user-open')}
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
