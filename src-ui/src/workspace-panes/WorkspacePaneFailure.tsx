import { useState } from 'react';
import { Button } from '../components/Button';
import { WarningGlyph } from '../components/icons/Glyph';
import './WorkspacePaneFailure.css';

/**
 * What a pane's error boundary caught, kept so the failure state can show it.
 * A render crash has no product-level reason: the honest description is the
 * error itself, behind a disclosure, not a guess dressed up as a cause.
 */
export interface WorkspacePaneFailureDetail {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Pane-specific context the host cannot derive on its own. It is read ONCE,
 * when the pane fails (the host and the frame's boundary both snapshot it),
 * so a later change elsewhere — another chat opened while this screen is up
 * — can neither relabel the failure nor redirect its actions.
 */
export interface WorkspacePaneFailureContext {
  /**
   * The thing inside the pane that failed, as plain text, and what it is —
   * e.g. `{ label: 'Chat', name: <title> }`. Shown under the heading.
   */
  subject?: { label: string; name: string };
  /**
   * A recovery that changes what the pane opens. The host retries the pane
   * after running it, so the pane remounts on the new state.
   */
  back?: { label: string; onBack: () => void };
  /**
   * The pane's own chrome goes with its renderer, so an owner whose chrome
   * could minimize it offers that here instead (e.g. collapse the chat dock).
   */
  dismiss?: { label: string; onDismiss: () => void };
}

export function workspacePaneFailureDetail(
  error: unknown,
): WorkspacePaneFailureDetail {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || '(no message)',
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

/**
 * A stack frame's location without the machine it was built on: a dev or
 * source build puts absolute paths (`/Users/<name>/…`) and origins in every
 * frame, and Copy details would put them on the clipboard for a bug report.
 * Each location keeps only its last segment (`index-abc.js:50:216`).
 */
function withoutLocations(frames: string): string {
  return frames.replace(/[^\s()@]*\/([^\s()/]+)/g, '$1');
}

function detailText(
  paneName: string,
  detail: WorkspacePaneFailureDetail | undefined,
): string {
  if (!detail) return `${paneName}: the error was not recorded.`;
  const heading = `${detail.name}: ${detail.message}`;
  // Only the first frames: enough to find the throw site, short enough to
  // read on a phone and paste into an issue. V8 stacks open with the heading
  // line; others (Safari, Firefox) are frames only.
  const lines = detail.stack?.split('\n').slice(0, 8) ?? [];
  const frames = (lines[0]?.startsWith(heading) ? lines.slice(1) : lines)
    .filter((line) => line.trim())
    .join('\n');
  return frames ? `${heading}\n${withoutLocations(frames)}` : heading;
}

/** Long enough for a real chat title, short enough never to crowd the card. */
const SUBJECT_MAX_CODE_POINTS = 120;

function cappedSubject(name: string): string {
  const points = Array.from(name);
  return points.length <= SUBJECT_MAX_CODE_POINTS
    ? name
    : `${points
        .slice(0, SUBJECT_MAX_CODE_POINTS - 1)
        .join('')
        .trimEnd()}\u2026`;
}

/**
 * The one failure state for a pane whose renderer threw (tabbed, chromeless
 * and dock hosts, and the frame's own boundary). It replaces a bare
 * "<Pane> could not open." paragraph that named nothing, explained nothing
 * and offered only a raw full-width retry.
 */
export function WorkspacePaneFailure({
  paneName,
  detail,
  context,
  onRetry,
  className,
}: {
  paneName: string;
  detail?: WorkspacePaneFailureDetail;
  context?: WorkspacePaneFailureContext;
  onRetry: () => void;
  className?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = detailText(paneName, detail);
  return (
    <section
      className={`workspace-pane-failure${className ? ` ${className}` : ''}`}
      aria-label={`${paneName} unavailable`}
    >
      <div className="workspace-pane-failure__card" role="alert">
        {context?.dismiss ? (
          <button
            type="button"
            className="workspace-pane-failure__dismiss"
            onClick={context.dismiss.onDismiss}
          >
            {context.dismiss.label}
          </button>
        ) : null}
        <span className="workspace-pane-failure__icon" aria-hidden="true">
          <WarningGlyph />
        </span>
        <h2 className="workspace-pane-failure__title">
          {paneName} couldn’t open
        </h2>
        {context?.subject ? (
          <p className="workspace-pane-failure__subject">
            <span className="workspace-pane-failure__subject-label">
              {context.subject.label}
            </span>
            <span
              className="workspace-pane-failure__subject-name"
              title={context.subject.name}
            >
              {cappedSubject(context.subject.name)}
            </span>
          </p>
        ) : null}
        <p className="workspace-pane-failure__reason">
          Station hit an unexpected error while showing this{' '}
          {paneName.toLowerCase()}.{' '}
          {context?.back
            ? `Try again, or ${context.back.label.toLowerCase()} and open something else.`
            : 'Try again to reload just this pane.'}
        </p>
        <div className="workspace-pane-failure__actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          {context?.back ? (
            <Button onClick={context.back.onBack}>{context.back.label}</Button>
          ) : null}
        </div>
        {/* Inside the card, under its actions: the raw error belongs to
            this failure, not to the page around it. */}
        <details className="workspace-pane-failure__details">
          <summary>Technical details</summary>
          <pre className="workspace-pane-failure__detail-text">{text}</pre>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(text))
                .then(
                  () => setCopied('copied'),
                  () => setCopied('failed'),
                );
            }}
          >
            {copied === 'copied'
              ? 'Copied'
              : copied === 'failed'
                ? 'Copy failed — select the text above'
                : 'Copy details'}
          </Button>
        </details>
      </div>
    </section>
  );
}
