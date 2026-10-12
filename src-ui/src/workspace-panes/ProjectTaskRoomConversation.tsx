import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import {
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomHistoryQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { TaskRoomComposer } from './TaskRoomComposer';
import { taskRoomRevisionLink } from './taskRoomRevisionLink';

function roomRecord(
  record: ProjectTaskRoomBrowserRecord,
  taskCreatedAt?: string,
): string {
  const actor = record.actor.label;
  const body = record.body;
  if (body.kind === 'output-feedback') {
    const version =
      taskCreatedAt && body.target.taskCreatedAt !== taskCreatedAt
        ? 'Earlier Task version. '
        : '';
    return `${actor}: ${version}${body.review === 'accepted' ? 'Reviewer accepted this version' : body.review === 'changes-requested' ? 'Reviewer requested changes' : 'Comment'} (${body.target.outputId}, version ${body.target.digest.slice(7, 15)}): ${body.text}`;
  }
  if (body.kind === 'human-message') return `${actor}: ${body.text}`;
  if (body.kind === 'live-work-started')
    return `${actor} is working on this Task.`;
  if (body.kind === 'live-work-presence-ended')
    return `${actor} left the room (${body.reason}).`;
  if (body.kind === 'live-work-finished')
    return `${actor} finished: ${String(body.outcome ?? 'unknown')}`;
  return `${actor}: ${body.link.kind} evidence`;
}

/** Room history is deliberately not a Chat store projection. */
export function ProjectTaskRoomConversation({
  taskId,
  projectSlug,
  taskCreatedAt,
}: {
  taskId: string;
  projectSlug?: string;
  taskCreatedAt?: string;
}) {
  const discover = useProjectTaskRoomDiscoveryQuery(taskId);
  const shared = useProjectTaskRoomContext(taskId);
  const history = useProjectTaskRoomHistoryQuery(taskId);
  const room = shared?.discovery ?? discover;
  const pages = history.data?.pages ?? [];
  const records = pages
    .flatMap((page) => (page.kind === 'available' ? page.records : []))
    .sort((left, right) => left.sequence - right.sequence);
  const writable =
    room.data?.kind === 'opened' || room.data?.kind === 'existing'
      ? room.data.capabilities.messageWrite && shared?.stream !== 'terminal'
      : false;
  const readable =
    room.data?.kind === 'opened' || room.data?.kind === 'existing'
      ? room.data.capabilities.historyRead
      : false;
  const capabilityStatus = room.isLoading
    ? 'Checking Task room capabilities…'
    : readable && writable
      ? 'Room history is readable and messages can be sent.'
      : readable
        ? 'Room history is readable and read-only.'
        : writable
          ? 'Message sending is available, but room history is not readable.'
          : 'Room history and message writing are unavailable.';
  return (
    <section
      className="project-task-room-conversation"
      aria-label="Task room conversation"
    >
      <header>
        <h2>Task conversation</h2>
        <p role="status">{capabilityStatus}</p>
      </header>
      {!readable && !room.isLoading ? (
        <p role="alert">History read is unavailable for this Task room.</p>
      ) : null}
      {history.isError ? (
        <p role="alert">
          Room history is unavailable. Retry when the connection is restored.
        </p>
      ) : null}
      {records.some((record) => record.body.kind === 'output-feedback') ? (
        <p>Output reviews are human statements. Task status is unchanged.</p>
      ) : null}
      <ol aria-live="polite" aria-label="Task room history">
        {records.map((record) => {
          const revision = taskRoomRevisionLink(
            record,
            room.data?.kind === 'opened' || room.data?.kind === 'existing'
              ? room.data.capabilities.revisionLinks
              : false,
          );
          const revisionBearing =
            record.body.kind === 'live-work-finished' ||
            (record.body.kind === 'outcome-link' &&
              record.body.link.kind === 'revision');
          return (
            <li key={record.sequence}>
              {roomRecord(record, taskCreatedAt)}
              {record.body.kind === 'output-feedback' ? (
                <details>
                  <summary>Reviewed version details</summary>
                  <p>
                    Output {record.body.target.outputId}. Full version:{' '}
                    {record.body.target.digest}. Task created{' '}
                    {record.body.target.taskCreatedAt}.
                  </p>
                </details>
              ) : null}
              {revisionBearing ? (
                revision.state === 'available' ? (
                  <span>{` Revision ${revision.link.stableId}.`}</span>
                ) : (
                  <span role="status"> {revision.reason}</span>
                )
              ) : null}
            </li>
          );
        })}
      </ol>
      {history.hasNextPage ? (
        <button
          type="button"
          onClick={() => void history.fetchNextPage()}
          disabled={history.isFetchingNextPage}
        >
          {history.isFetchingNextPage
            ? 'Loading earlier updates…'
            : 'Load earlier updates'}
        </button>
      ) : null}
      {pages.some((page) => page.kind === 'gap') ? (
        <p role="alert">
          Earlier room history is unavailable. The retained suffix can be
          resumed when the server provides its continuation cursor.
        </p>
      ) : null}
      {!projectSlug || !taskCreatedAt ? (
        <p role="status">Verifying Task identity before sending.</p>
      ) : null}
      <TaskRoomComposer
        taskId={taskId}
        projectSlug={projectSlug ?? ''}
        taskCreatedAt={taskCreatedAt ?? ''}
        writable={writable && !!projectSlug && !!taskCreatedAt}
        readable={readable}
      />
    </section>
  );
}
