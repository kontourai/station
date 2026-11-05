import type { ProjectSharedTaskHistory } from '@kontourai/station-contracts/project-shared-task';
import type { ProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import type { ReactNode } from 'react';
import { RoomAvatar } from '../../workspace-panes/ProjectTaskRoomPresence';
import { Button } from '../Button';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { Empty, ErrorState, SkeletonBlock, SkeletonList } from '../state';
import './SharedTaskHistoryList.css';

type HistoryPage = ProjectSharedTaskHistory | ProjectTaskRoomBrowserHistory;
type HistoryRecord = Extract<
  HistoryPage,
  { kind: 'available' }
>['records'][number];

export function taskHistoryReadDenied(error: unknown) {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    [401, 403, 404].includes(error.status)
  );
}

/** Keep the server's record projection and fixed checkpoint; never synthesize messages. */
export function projectTaskHistory<T extends HistoryRecord>(
  pages: readonly (HistoryPage & { records?: readonly T[] })[],
) {
  const checkpoint = pages.find(
    (page) => page.kind === 'available',
  )?.checkpoint;
  const invalid = pages.find((page) => page.kind !== 'available');
  const changedCheckpoint = pages.some(
    (page) =>
      page.kind === 'available' &&
      checkpoint &&
      (page.checkpoint.throughSeq !== checkpoint.throughSeq ||
        page.checkpoint.checkpointDigest !== checkpoint.checkpointDigest ||
        page.checkpoint.retainedAnchorSeq !== checkpoint.retainedAnchorSeq ||
        page.checkpoint.retainedAnchorDigest !==
          checkpoint.retainedAnchorDigest),
  );
  const outcome = changedCheckpoint ? 'stale' : invalid?.kind;
  // A typed non-available page invalidates the window. A request failure is
  // separate: the caller may keep the already admitted rows and retry that page.
  const records = outcome
    ? []
    : [
        ...new Map(
          pages
            .flatMap((page) => (page.kind === 'available' ? page.records : []))
            .map((record) => [record.sequence, record] as const),
        ).values(),
      ].sort((a, b) => a.sequence - b.sequence);
  return { records, outcome };
}

export function SharedTaskHistoryText({ text }: { text: string }) {
  const mention = /^\*\*@(.+?)\*\*\s+/.exec(text);
  return (
    <div className="task-room-message-text">
      {mention && <span className="task-room-mention">@{mention[1]}</span>}
      <LazyMarkdown
        skipHtml
        loadingProjection={<SkeletonBlock label="Loading message" />}
      >
        {mention ? text.slice(mention[0].length) : text}
      </LazyMarkdown>
    </div>
  );
}

export function SharedTaskHistoryRecord({
  record,
  previous,
  authorLabel = record.actor.label,
  children,
  header,
  attachments,
  actions,
}: {
  record: HistoryRecord;
  previous?: HistoryRecord;
  authorLabel?: string;
  children?: ReactNode;
  header?: ReactNode;
  attachments?: ReactNode;
  actions?: ReactNode;
}) {
  const grouped =
    previous?.body.kind === 'human-message' &&
    previous.actor.kind === record.actor.kind &&
    ('id' in previous.actor
      ? (previous.actor.id ?? previous.actor.label)
      : previous.actor.label) ===
      ('id' in record.actor
        ? (record.actor.id ?? record.actor.label)
        : record.actor.label);
  return (
    <li
      className={`task-room-message${grouped ? ' task-room-message--grouped' : ''}`}
    >
      {!grouped && (
        <RoomAvatar name={authorLabel} agent={record.actor.kind === 'agent'} />
      )}
      <article>
        <header>
          {!grouped && (
            <>
              <strong>{authorLabel}</strong>
              {record.actor.kind === 'agent' && (
                <span className="task-room-agent-badge">Agent</span>
              )}
            </>
          )}
          {header}
        </header>
        {attachments}
        <div className="task-room-message-content">
          {children ??
            (record.body.kind === 'human-message' && (
              <SharedTaskHistoryText text={record.body.text} />
            ))}
        </div>
        {actions}
      </article>
    </li>
  );
}

function outcomeText(outcome: string) {
  switch (outcome) {
    case 'denied':
      return 'History is not shared with this connection.';
    case 'not-found':
      return 'This Task is no longer shared.';
    case 'gap':
      return 'Earlier history is unavailable.';
    case 'stale':
      return 'History changed. Refresh to read the current record.';
    case 'invalid-cursor':
      return 'This history page expired. Refresh to continue.';
    case 'too-large':
      return 'Shared history is too large to display.';
    default:
      return 'Shared history is unavailable.';
  }
}

export function SharedTaskHistoryList<T extends HistoryRecord>({
  records,
  readable,
  pending,
  failed,
  outcome,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  onRetry,
  renderRecord,
  label = 'Shared history records',
  emptyLabel = 'No published messages yet.',
}: {
  records: readonly T[];
  readable: boolean;
  pending?: boolean;
  failed?: boolean;
  outcome?: string;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier: () => void;
  onRetry: () => void;
  renderRecord?: (record: T, previous: T | undefined) => ReactNode;
  label?: string;
  emptyLabel?: string;
}) {
  if (!readable)
    return <p role="status">History is not shared with this connection.</p>;
  if (outcome)
    return (
      <ErrorState
        variant="compact"
        title={outcomeText(outcome)}
        action={<Button onClick={onRetry}>Refresh history</Button>}
      />
    );
  return (
    <div
      className="shared-task-history"
      aria-busy={pending || loadingEarlier || undefined}
    >
      {hasEarlier && (
        <Button
          variant="ghost"
          onClick={onLoadEarlier}
          pending={loadingEarlier}
        >
          Load earlier messages
        </Button>
      )}
      {pending && <SkeletonList count={2} label="Loading messages" />}
      {failed && (
        <ErrorState
          variant="compact"
          title={
            records.length
              ? 'Couldn’t load more history.'
              : 'Shared history is unavailable.'
          }
          action={<Button onClick={onRetry}>Retry</Button>}
        />
      )}
      {!pending && !failed && !records.length && (
        <Empty variant="compact" label={emptyLabel} />
      )}
      <ol aria-live="polite" aria-label={label}>
        {records.map((record, index) =>
          renderRecord ? (
            renderRecord(record, records[index - 1])
          ) : (
            <SharedTaskHistoryRecord
              key={record.sequence}
              record={record}
              previous={records[index - 1]}
            />
          ),
        )}
      </ol>
    </div>
  );
}
