import { lazy, Suspense } from 'react';
import { Skeleton } from '../state';
import { LazyMarkdown } from './LazyMarkdown';

// DOMPurify is ~118 KB of source and only the rare `contentType: 'html'`
// ephemeral message needs it, so the sanitizing renderer loads on demand.
const SanitizedHtml = lazy(() =>
  import('./SanitizedHtml').then((m) => ({ default: m.SanitizedHtml })),
);

interface EphemeralAction {
  label: string;
  handler: () => void;
}

interface EphemeralMsg {
  id?: string;
  content: string;
  contentType?: 'html' | 'markdown';
  action?: EphemeralAction;
  contentParts?: { type: string; content?: string }[];
}

interface EphemeralMessageProps {
  msg: EphemeralMsg;
  idx: number;
  fontSize: number;
  isRemoving: boolean;
  onDismiss: () => void;
  onAction?: () => void;
}

function safeWebHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep actionable web links usable while the Markdown renderer chunk loads.
 * The full renderer replaces this projection as soon as it is ready; this
 * deliberately recognizes only ordinary inline Markdown links and leaves all
 * other source text untouched.
 */
export function MarkdownLoadingProjection({ source }: { source: string }) {
  // This is intentionally bounded. The loading projection runs on message text
  // before the Markdown chunk arrives; an unclosed run of `[` used to make the
  // global matcher rescan almost the entire message from each character.
  const matches = [
    ...source.matchAll(/\[([^[\]]{1,512})\]\(([^)]{1,512})\)/gu),
  ];
  if (matches.length === 0) return source;

  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const match of matches) {
    const start = match.index ?? offset;
    parts.push(source.slice(offset, start));
    const href = safeWebHref(match[2] ?? '');
    parts.push(
      href ? (
        <a href={href} key={start}>
          {match[1]}
        </a>
      ) : (
        match[0]
      ),
    );
    offset = start + match[0].length;
  }
  parts.push(source.slice(offset));
  return <>{parts}</>;
}

export function EphemeralMessage({
  msg,
  idx,
  fontSize,
  isRemoving,
  onDismiss,
  onAction,
}: EphemeralMessageProps) {
  const messageId = msg.id || `ephemeral-${idx}`;
  const textContent =
    msg.contentParts
      ?.filter((p) => p.type === 'text')
      .map((p) => p.content)
      .join('\n') ||
    msg.content ||
    '';

  return (
    <div
      key={messageId}
      className={`message system ephemeral-message ${isRemoving ? 'removing' : ''}`}
      style={{
        padding: '12px 40px 12px 12px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '6px',
        marginTop: '8px',
        marginBottom: '0',
        position: 'relative',
        fontSize: `${fontSize}px`,
        textAlign: 'left',
        alignSelf: 'flex-start',
        width: '100%',
        opacity: isRemoving ? 0 : 1,
        transform: isRemoving ? 'translateY(-10px)' : 'translateY(0px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <button
        type="button"
        onClick={onDismiss}
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '18px',
          color: 'var(--text-muted)',
          padding: '4px',
          lineHeight: 1,
        }}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
      {msg.contentType === 'html' ? (
        <Suspense fallback={<Skeleton variant="line" />}>
          <SanitizedHtml html={msg.content} />
        </Suspense>
      ) : (
        <LazyMarkdown
          loadingProjection={<MarkdownLoadingProjection source={textContent} />}
        >
          {textContent}
        </LazyMarkdown>
      )}
      {msg.action && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            marginTop: '12px',
            padding: '8px 16px',
            borderRadius: '6px',
            border: 'none',
            background: 'var(--color-primary)',
            color: 'white',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {msg.action.label}
        </button>
      )}
    </div>
  );
}
