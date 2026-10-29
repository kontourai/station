import type { TaskWriteBackEntry } from '@kontourai/station-contracts/task-write-back';
import { useTaskWriteBackQuery } from '@kontourai/station-sdk';
import { Badge } from '@kontourai/ui/react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import './TaskWriteBackSection.css';

const stateLabels = {
  pending: { label: 'Pending', tone: 'active' },
  succeeded: { label: 'Succeeded', tone: 'positive' },
  failed: { label: 'Failed', tone: 'negative' },
} as const;

function attemptAnchor(ordinal: number) {
  return `task-write-back-attempt-${ordinal}`;
}

function formatTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function WriteBackEntries({
  entries,
}: {
  entries: readonly TaskWriteBackEntry[];
}) {
  return (
    <ol className="task-write-back__entries">
      {entries.map((entry) => {
        const original = entry.retryOf
          ? entries.find((candidate) => candidate.id === entry.retryOf)
          : undefined;
        const retries = entry.retryOf
          ? []
          : entries.filter((candidate) => candidate.retryOf === entry.id);
        const state = stateLabels[entry.state];
        return (
          <li key={entry.id} id={attemptAnchor(entry.ordinal)}>
            <div className="task-write-back__entry-heading">
              <strong>Attempt {entry.ordinal}</strong>
              <Badge value={state.label} tone={state.tone} />
              <time dateTime={entry.attemptedAt}>
                {formatTime(entry.attemptedAt)}
              </time>
            </div>
            <p>
              {entry.target.system} · {entry.target.action} ·{' '}
              {entry.target.destination}
            </p>
            {entry.failureReason && <p>{entry.failureReason}</p>}
            {original && (
              <p>
                Retry of{' '}
                <a href={`#${attemptAnchor(original.ordinal)}`}>
                  attempt {original.ordinal}
                </a>
              </p>
            )}
            {retries.length > 0 && (
              <p>
                Retried in{' '}
                {retries.map((retry, index) => (
                  <span key={retry.id}>
                    {index > 0 && ', '}
                    <a href={`#${attemptAnchor(retry.ordinal)}`}>
                      attempt {retry.ordinal}
                    </a>
                  </span>
                ))}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function TaskWriteBackSection({
  taskId,
  taskCreatedAt,
}: {
  taskId: string;
  taskCreatedAt: string;
}) {
  const authority = useHostRequestAuthorityScope();
  if (!authority) return null;
  return (
    <TaskWriteBackForAuthority
      key={`${authority.apiBase}:${authority.authorityKey}:${taskId}:${taskCreatedAt}`}
      authority={authority}
      taskId={taskId}
      taskCreatedAt={taskCreatedAt}
    />
  );
}

function TaskWriteBackForAuthority({
  authority,
  taskId,
  taskCreatedAt,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  taskId: string;
  taskCreatedAt: string;
}) {
  const [open, setOpen] = useState(false);
  const log = useTaskWriteBackQuery(authority.apiBase, taskId, {
    requestScope: authority,
    enabled: open,
    cancelWhenInactive: true,
  });
  const wrongIncarnation = log.data?.entries.some(
    (entry) => entry.taskCreatedAt !== taskCreatedAt,
  );
  return (
    <details
      className="task-write-back"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Written to the issue</summary>
      {open && (
        <div className="task-write-back__body">
          {log.isError || wrongIncarnation ? (
            <ErrorState
              variant="compact"
              title="Write-back history unavailable"
              description="Check the Task connection and try again."
              action={<Button onClick={() => void log.refetch()}>Retry</Button>}
            />
          ) : log.isFetching || !log.data ? (
            <SkeletonBlock count={2} label="Loading write-back history" />
          ) : log.data.entries.length === 0 ? (
            <Empty
              variant="compact"
              label="No recorded writes yet"
              description="Only writes recorded by Station appear here."
            />
          ) : (
            <WriteBackEntries entries={log.data.entries} />
          )}
        </div>
      )}
    </details>
  );
}
