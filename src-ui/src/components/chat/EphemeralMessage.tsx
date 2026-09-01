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

const MAX_INLINE_LINK_SEGMENT_CODE_POINTS = 512;
const MAX_MARKDOWN_LOADING_CANDIDATES = MAX_INLINE_LINK_SEGMENT_CODE_POINTS + 1;

interface MarkdownLoadingLink {
  start: number;
  end: number;
  label: string;
  target: string;
}

interface MarkdownLoadingLabelOpener {
  start: number;
  labelStart: number;
  codePointIndex: number;
}

interface MarkdownLoadingTargetCandidate {
  start: number;
  labelStart: number;
  labelEnd: number;
  targetStart: number;
  targetStartCodePoint: number;
}

/** A fixed-capacity FIFO keeps grammar candidates bounded independent of input. */
class MarkdownLoadingCandidateDeque<T> {
  private readonly values: Array<T | undefined> = Array(
    MAX_MARKDOWN_LOADING_CANDIDATES,
  );
  private head = 0;
  private length = 0;

  first(): T | undefined {
    return this.length > 0 ? this.values[this.head] : undefined;
  }

  removeFirst(): void {
    if (this.length === 0) return;
    this.values[this.head] = undefined;
    this.head = (this.head + 1) % MAX_MARKDOWN_LOADING_CANDIDATES;
    this.length -= 1;
  }

  push(value: T): void {
    if (this.length === MAX_MARKDOWN_LOADING_CANDIDATES) {
      throw new Error(
        'Markdown loading candidate queue exceeded its grammar cap',
      );
    }
    this.values[(this.head + this.length) % MAX_MARKDOWN_LOADING_CANDIDATES] =
      value;
    this.length += 1;
  }

  clear(): void {
    while (this.length > 0) this.removeFirst();
  }
}

/**
 * Scan the deliberately small loading-time Markdown grammar in one forward
 * pass. The matching test exercises hostile input as a semantic contract, not
 * a host-load-sensitive wall-clock sample.
 */
function scanMarkdownLoadingLinks(
  source: string,
): readonly MarkdownLoadingLink[] {
  const matches: MarkdownLoadingLink[] = [];
  let offset = 0;
  let codePointIndex = 0;
  const labelOpeners =
    new MarkdownLoadingCandidateDeque<MarkdownLoadingLabelOpener>();
  const targetCandidates =
    new MarkdownLoadingCandidateDeque<MarkdownLoadingTargetCandidate>();
  let pendingTarget:
    | Omit<
        MarkdownLoadingTargetCandidate,
        'targetStart' | 'targetStartCodePoint'
      >
    | undefined;

  for (const character of source) {
    const nextOffset = offset + character.length;

    const targetMaxDistance =
      character === ')'
        ? MAX_INLINE_LINK_SEGMENT_CODE_POINTS
        : MAX_INLINE_LINK_SEGMENT_CODE_POINTS - 1;
    while (
      targetCandidates.first() &&
      codePointIndex - targetCandidates.first()!.targetStartCodePoint >
        targetMaxDistance
    ) {
      targetCandidates.removeFirst();
    }

    const labelMaxDistance =
      character === ']'
        ? MAX_INLINE_LINK_SEGMENT_CODE_POINTS + 1
        : MAX_INLINE_LINK_SEGMENT_CODE_POINTS;
    while (
      labelOpeners.first() &&
      codePointIndex - labelOpeners.first()!.codePointIndex > labelMaxDistance
    ) {
      labelOpeners.removeFirst();
    }

    if (character === ')') {
      const candidate = targetCandidates.first();
      if (
        candidate &&
        codePointIndex > candidate.targetStartCodePoint &&
        codePointIndex - candidate.targetStartCodePoint <=
          MAX_INLINE_LINK_SEGMENT_CODE_POINTS
      ) {
        matches.push({
          start: candidate.start,
          end: nextOffset,
          label: source.slice(candidate.labelStart, candidate.labelEnd),
          target: source.slice(candidate.targetStart, offset),
        });
        // A global Markdown match consumes every nested candidate through its
        // closing delimiter, so the next scan starts cleanly after this point.
        labelOpeners.clear();
        pendingTarget = undefined;
      }
      targetCandidates.clear();
      pendingTarget = undefined;
    } else {
      if (pendingTarget) {
        if (character === '(') {
          targetCandidates.push({
            ...pendingTarget,
            targetStart: nextOffset,
            targetStartCodePoint: codePointIndex + 1,
          });
        }
        pendingTarget = undefined;
      }

      if (character === '[') {
        labelOpeners.push({
          start: offset,
          labelStart: nextOffset,
          codePointIndex,
        });
      } else if (character === ']') {
        const opener = labelOpeners.first();
        pendingTarget =
          opener && codePointIndex - opener.codePointIndex > 1
            ? {
                start: opener.start,
                labelStart: opener.labelStart,
                labelEnd: offset,
              }
            : undefined;
        // A label cannot cross `]`; future candidates begin after it.
        labelOpeners.clear();
      }
    }

    offset = nextOffset;
    codePointIndex += 1;
  }

  return matches;
}

/**
 * Keep actionable web links usable while the Markdown renderer chunk loads.
 * The full renderer replaces this projection as soon as it is ready; this
 * deliberately recognizes only ordinary inline Markdown links and leaves all
 * other source text untouched.
 */
export function MarkdownLoadingProjection({ source }: { source: string }) {
  const matches = scanMarkdownLoadingLinks(source);
  if (matches.length === 0) return source;

  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const [index, match] of matches.entries()) {
    parts.push(source.slice(offset, match.start));
    const href = safeWebHref(match.target);
    parts.push(
      href ? (
        <a href={href} key={`${match.start}-${index}`}>
          {match.label}
        </a>
      ) : (
        source.slice(match.start, match.end)
      ),
    );
    offset = match.end;
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
