import { useState } from 'react';
import { Button } from '../components/Button';
import { ErrorState } from '../components/state';
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
 * Pane-specific context the host cannot derive on its own. The Chat pane
 * names the conversation that was open and offers a way back to the chat
 * list, which is the one recovery a retry cannot provide when the crash is
 * specific to that conversation.
 */
export interface WorkspacePaneFailureContext {
  /** The thing inside the pane that failed, e.g. the open chat's title. */
  subject?: string;
  /**
   * A recovery that changes what the pane opens. The host retries the pane
   * after running it, so the pane remounts on the new state.
   */
  back?: { label: string; onBack: () => void };
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

function detailText(
  paneName: string,
  detail: WorkspacePaneFailureDetail | undefined,
): string {
  if (!detail) return `${paneName}: the error was not recorded.`;
  const heading = `${detail.name}: ${detail.message}`;
  // Only the first frames: enough to find the throw site, short enough to
  // read on a phone and paste into an issue. V8 stacks already open with the
  // heading; others (Safari, Firefox) are frames only.
  const stack = detail.stack?.split('\n').slice(0, 8).join('\n');
  if (!stack) return heading;
  return stack.startsWith(heading) ? stack : `${heading}\n${stack}`;
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
      <ErrorState
        variant="compact"
        title={`${paneName} couldn’t open`}
        description={
          <>
            {context?.subject ? (
              <span className="workspace-pane-failure__subject">
                {context.subject}
              </span>
            ) : null}
            <span className="workspace-pane-failure__reason">
              Station hit an unexpected error while showing this{' '}
              {paneName.toLowerCase()}.{' '}
              {context?.back
                ? 'Try again, or go back and open something else.'
                : 'Try again to reload just this pane.'}
            </span>
          </>
        }
        action={
          <span className="workspace-pane-failure__actions">
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
            {context?.back ? (
              <Button onClick={context.back.onBack}>
                {context.back.label}
              </Button>
            ) : null}
          </span>
        }
      />
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
    </section>
  );
}
