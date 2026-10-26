import type { SessionInventoryViewItem } from '@kontourai/station-basis-pane/session-inventory-view';
import type {
  ThreadAuthoredInputRow,
  ThreadToolResultRow,
} from '@kontourai/station-contracts/session-inventory';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import {
  SessionInventoryRequestError,
  useSessionInventoryInput,
} from '@kontourai/station-sdk/session-inventory';
import {
  TaskToolResultRequestError,
  useSessionToolResultQuery,
} from '@kontourai/station-sdk/task-tool-results';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useShowSurface } from '../contexts/useShowSurface';

/**
 * What a failed body read can honestly tell the user, and whether trying
 * again could change it. The read routes answer a missing, denied or
 * stale-principal read alike (404, non-disclosing), and 401/403 come from
 * authentication; retrying any of those gets the same answer. A 2xx the
 * client refused is a contract mismatch, also not fixed by retrying. Only an
 * outage (503) or no response at all (status 0) is worth another try.
 */
export function describeItemReadFailure(
  error: unknown,
  noun: 'input' | 'tool result',
): { title: string; description: string; retryable: boolean } {
  // Both clients throw only their own typed error; `0` is "no response".
  const status =
    error instanceof SessionInventoryRequestError ||
    error instanceof TaskToolResultRequestError
      ? error.status
      : 0;
  if (status === 401 || status === 403 || status === 404)
    return {
      title: `This ${noun} isn't available`,
      description:
        'It may have been removed, or this device may no longer have access to this session.',
      retryable: false,
    };
  if (status >= 200 && status < 300)
    return {
      title: `This ${noun} couldn't be shown`,
      description:
        'Station sent a response this app could not read. Update this app or the Station host so both run the same version.',
      retryable: false,
    };
  return {
    title: `This ${noun} didn't load`,
    description:
      status === 0
        ? 'Station could not be reached. Check the connection, then try again.'
        : 'Station could not read it just now. Try again in a moment.',
    retryable: true,
  };
}

function ReadFailure({
  title,
  description,
  retry,
  fallback,
}: {
  title: string;
  description: ReactNode;
  retry?: {
    label: string;
    onRetry(): void;
    pending?: boolean;
    pendingLabel?: string;
  };
  fallback?: ReactNode;
}) {
  return (
    <ErrorState
      variant="default"
      className="session-inventory__item-failure"
      title={title}
      description={description}
      action={
        retry || fallback ? (
          <div className="session-inventory__item-details-actions">
            {retry ? (
              <Button
                variant="primary"
                onClick={retry.onRetry}
                pending={retry.pending}
                pendingLabel={retry.pendingLabel}
              >
                {retry.label}
              </Button>
            ) : null}
            {fallback}
          </div>
        ) : undefined
      }
    />
  );
}

function InputDetails({
  row,
  requestScope,
  footer,
  fallback,
}: {
  row: ThreadAuthoredInputRow;
  requestScope: ApiRequestScope;
  footer: ReactNode;
  fallback: ReactNode;
}) {
  const query = useSessionInventoryInput(
    row.sessionId,
    row.eventId,
    row.turnId,
    requestScope,
  );
  if (query.hostSupport === 'unsupported') {
    const stillOld = query.hostRecheck === 'still-unsupported';
    return (
      <ReadFailure
        title={
          stillOld
            ? 'Station is still on an older version'
            : 'Update Station to see this input'
        }
        description={
          stillOld
            ? "Station checked the host again just now, and it still runs a version that can't show input details. Update Station on the host and check again, or open the session to read the message in the conversation."
            : "The Station host this app is connected to runs an older version that can't show input details. Update Station on the host and check again, or open the session to read the message in the conversation."
        }
        retry={{
          label: 'Check again',
          onRetry: () => void query.recheckHost(),
          pending: query.hostRecheck === 'checking',
          pendingLabel: 'Checking…',
        }}
        fallback={fallback}
      />
    );
  }
  if (query.error) {
    const failure = describeItemReadFailure(query.error, 'input');
    return (
      <ReadFailure
        title={failure.title}
        description={failure.description}
        retry={
          failure.retryable
            ? { label: 'Try again', onRetry: () => void query.refetch() }
            : undefined
        }
        fallback={fallback}
      />
    );
  }
  if (!query.data)
    return <SkeletonBlock count={2} label="Loading input details" />;
  // The row's own title already names the input kind; the body is its text.
  return (
    <>
      {query.data.prompt ? (
        <pre className="session-inventory__input-text">{query.data.prompt}</pre>
      ) : (
        <p>This input contains attachments only.</p>
      )}
      {query.data.attachments.length ? (
        <ul aria-label="Input attachments">
          {query.data.attachments.map((file, index) => (
            <li key={index}>
              {file.name} · {file.mediaType} · {file.size.toLocaleString()}{' '}
              bytes
            </li>
          ))}
        </ul>
      ) : null}
      {footer}
    </>
  );
}

function ToolDetails({
  row,
  requestScope,
  footer,
  fallback,
}: {
  row: ThreadToolResultRow;
  requestScope: ApiRequestScope;
  footer: ReactNode;
  fallback: ReactNode;
}) {
  const query = useSessionToolResultQuery(row.sessionId, row.eventId, {
    requestScope,
  });
  if (query.error) {
    const failure = describeItemReadFailure(query.error, 'tool result');
    return (
      <ReadFailure
        title={failure.title}
        description={failure.description}
        retry={
          failure.retryable
            ? { label: 'Try again', onRetry: () => void query.refetch() }
            : undefined
        }
        fallback={fallback}
      />
    );
  }
  if (!query.data)
    return <SkeletonBlock count={2} label="Loading tool result" />;
  const result = query.data;
  // The row's own title already names the tool.
  return (
    <>
      <p>Status: {result.terminalStatus}</p>
      {result.content.map((part, index) =>
        part.type === 'text' ? (
          <pre key={index}>{part.text}</pre>
        ) : (
          <p key={index}>
            {part.type === 'image'
              ? `Image (${part.mediaType})`
              : `File: ${part.name} (${part.mediaType})`}
          </p>
        ),
      )}
      {result.truncated ? (
        <p role="status">
          This recorded result is truncated. Some content was omitted.
        </p>
      ) : null}
      {footer}
    </>
  );
}

/** Bodies are mounted only for the exact selected row, under its current authority. */
export function SessionInventoryItemDetails({
  item,
  requestScope,
  onDismiss,
}: {
  item: SessionInventoryViewItem;
  requestScope: ApiRequestScope;
  onDismiss?(): void;
}) {
  const showSurface = useShowSurface();
  const openSession = (session: string) => {
    onDismiss?.();
    showSurface('activity', { session });
  };
  const row = item.row;
  if (!row)
    return <p role="status">Live activity has no retained detail yet.</p>;
  const sessionId =
    'sessionId' in row
      ? row.sessionId
      : 'provenanceSessionId' in row
        ? row.provenanceSessionId
        : undefined;
  const openSessionButton = sessionId ? (
    <Button onClick={() => openSession(sessionId)}>Open session</Button>
  ) : null;
  // The recorded origin describes a body that was read. Under a failed read
  // it is noise between the failure and what to do next, so the body owns
  // whether it appears; Open session moves into the failure as its way out.
  const footer = (
    <div className="session-inventory__item-details-footer">
      <details>
        <summary>Recorded origin</summary>
        <dl>
          <dt>Owner</dt>
          <dd>{row.owner.owner}</dd>
          {sessionId ? (
            <>
              <dt>Session</dt>
              <dd>{sessionId}</dd>
            </>
          ) : null}
          {'turnId' in row && row.turnId ? (
            <>
              <dt>Turn</dt>
              <dd>{row.turnId}</dd>
            </>
          ) : null}
          {'eventId' in row ? (
            <>
              <dt>Event</dt>
              <dd>{row.eventId}</dd>
            </>
          ) : null}
          <dt>Relationship</dt>
          <dd>{row.relations.join(', ')}</dd>
        </dl>
      </details>
      {openSessionButton ? (
        <div className="session-inventory__item-details-actions">
          {openSessionButton}
        </div>
      ) : null}
    </div>
  );
  const bodyOwnsFooter =
    row.kind === 'thread-authored-input' || row.kind === 'thread-tool-result';
  return (
    <section
      className="session-inventory__item-details"
      aria-label={`${item.label} details`}
    >
      {row.kind === 'thread-authored-input' ? (
        <InputDetails
          row={row}
          requestScope={requestScope}
          footer={footer}
          fallback={openSessionButton}
        />
      ) : null}
      {row.kind === 'thread-tool-result' ? (
        <ToolDetails
          row={row}
          requestScope={requestScope}
          footer={footer}
          fallback={openSessionButton}
        />
      ) : null}
      {row.kind === 'station-request-decision' ? (
        <>
          <h4>Recorded decision</h4>
          <p>{row.status}</p>
          <p>Request: {row.requestId}</p>
          <p>
            Open the session to read the request and surrounding conversation.
          </p>
        </>
      ) : null}
      {row.kind === 'station-plan-snapshot' ? (
        <>
          <h4>Plan snapshot</h4>
          <p>
            Revision {row.revision}. Open the session to inspect the recorded
            plan.
          </p>
        </>
      ) : null}
      {row.kind === 'station-delegation' ? (
        <>
          <h4>Delegated work</h4>
          <p>Child session: {row.childSessionId}</p>
          <Button onClick={() => openSession(row.childSessionId)}>
            Open delegated session
          </Button>
        </>
      ) : null}
      {row.kind === 'station-resource-summary' ? (
        <dl>
          {Object.entries({
            Model: row.model,
            Engine: row.engine,
            'Input tokens': row.inputTokens,
            'Output tokens': row.outputTokens,
            'Cached tokens': row.cachedTokens,
            'Elapsed milliseconds': row.elapsedMs,
          })
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      ) : null}
      {row.kind === 'surface-answer-contribution' ? (
        <dl>
          <dt>Review</dt>
          <dd>{row.reviewedSource.review}</dd>
          <dt>Currentness</dt>
          <dd>{row.reviewedSource.currentness}</dd>
          <dt>Checked</dt>
          <dd>{row.reviewedSource.checkedAt}</dd>
        </dl>
      ) : null}
      {row.kind === 'flow-gate-verdict' ||
      row.kind === 'flow-policy-verdict' ||
      row.kind === 'gate-evaluation' ? (
        <>
          <h4>Recorded verdict</h4>
          <p>{row.verdict}</p>
          <p>
            {row.kind === 'flow-gate-verdict'
              ? row.gateId
              : row.kind === 'flow-policy-verdict'
                ? row.policyId
                : row.evaluationId}
          </p>
        </>
      ) : null}
      {row.kind === 'flow-agents-narrative' ? (
        <>
          <h4>Retained narrative</h4>
          <p>Captured {row.capturedAt}</p>
          <p>{row.narrativeRef}</p>
        </>
      ) : null}
      {'taskId' in row ? (
        <>
          <h4>Kept reference</h4>
          <p>Task: {row.taskId}</p>
          <p>Reference: {row.referenceId}</p>
        </>
      ) : null}
      {row.kind === 'station-session-output' ? (
        <>
          <h4>Declared output</h4>
          <p>{row.output.label ?? row.output.descriptor.kind}</p>
          <p>
            Declared {row.output.declaredAt}. Use Inspect output below to open
            its contents.
          </p>
        </>
      ) : null}
      {bodyOwnsFooter ? null : footer}
    </section>
  );
}
