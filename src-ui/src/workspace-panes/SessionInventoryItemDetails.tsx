import type { SessionInventoryViewItem } from '@kontourai/station-basis-pane/session-inventory-view';
import type {
  ThreadAuthoredInputRow,
  ThreadToolResultRow,
} from '@kontourai/station-contracts/session-inventory';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useSessionInventoryInput } from '@kontourai/station-sdk/session-inventory';
import { useSessionToolResultQuery } from '@kontourai/station-sdk/task-tool-results';
import { Button } from '../components/Button';
import { SkeletonBlock } from '../components/state';
import { useShowSurface } from '../contexts/useShowSurface';

function InputDetails({
  row,
  requestScope,
}: {
  row: ThreadAuthoredInputRow;
  requestScope: ApiRequestScope;
}) {
  const query = useSessionInventoryInput(
    row.sessionId,
    row.eventId,
    row.turnId,
    requestScope,
  );
  if (query.error)
    return (
      <p role="alert">
        This input could not be read.{' '}
        <Button onClick={() => void query.refetch()}>Retry input</Button>
      </p>
    );
  if (!query.data)
    return <SkeletonBlock count={2} label="Loading input details" />;
  return (
    <>
      <h4>
        {row.inputKind === 'steer'
          ? 'Follow-up instruction'
          : 'Authored message'}
      </h4>
      {query.data.prompt ? (
        <pre>{query.data.prompt}</pre>
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
    </>
  );
}

function ToolDetails({
  row,
  requestScope,
}: {
  row: ThreadToolResultRow;
  requestScope: ApiRequestScope;
}) {
  const query = useSessionToolResultQuery(row.sessionId, row.eventId, {
    requestScope,
  });
  if (query.error)
    return (
      <p role="alert">
        This tool result could not be read.{' '}
        <Button onClick={() => void query.refetch()}>Retry result</Button>
      </p>
    );
  if (!query.data)
    return <SkeletonBlock count={2} label="Loading tool result" />;
  const result = query.data;
  return (
    <>
      <h4>{result.name}</h4>
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
  return (
    <section
      className="session-inventory__item-details"
      aria-label={`${item.label} details`}
    >
      {row.kind === 'thread-authored-input' ? (
        <InputDetails row={row} requestScope={requestScope} />
      ) : null}
      {row.kind === 'thread-tool-result' ? (
        <ToolDetails row={row} requestScope={requestScope} />
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
      {sessionId ? (
        <Button onClick={() => openSession(sessionId)}>Open session</Button>
      ) : null}
    </section>
  );
}
