interface ReasoningSectionProps {
  content: string;
  fontSize: number;
  show: boolean;
}

export function ReasoningSection({
  content,
  fontSize,
  show,
}: ReasoningSectionProps) {
  if (!show) return null;

  return (
    <div
      className="reasoning-section"
      style={{
        display: 'block',
        margin: '0.5rem 0',
        padding: '0.5rem',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: '4px',
        fontSize: `${fontSize}px`,
      }}
    >
      <div
        style={{
          fontSize: '0.85em',
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
          lineHeight: '1.5',
        }}
      >
        {content}
      </div>
    </div>
  );
}
