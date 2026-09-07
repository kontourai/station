import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import {
  useAppendProjectTaskRoomHumanMessageMutation,
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomHistoryQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useId, useState } from 'react';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { taskRoomRevisionLink } from './taskRoomRevisionLink';

function roomRecord(record: ProjectTaskRoomBrowserRecord): string {
  const actor = record.actor.label;
  const body = record.body;
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
export function ProjectTaskRoomConversation({ taskId }: { taskId: string }) {
  const discover = useProjectTaskRoomDiscoveryQuery(taskId);
  const shared = useProjectTaskRoomContext(taskId);
  const history = useProjectTaskRoomHistoryQuery(taskId);
  const append = useAppendProjectTaskRoomHumanMessageMutation(taskId);
  const [draft, setDraft] = useState('');
  const id = useId().replaceAll(':', '');
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
  const submit = () => {
    const text = draft.trim();
    if (!text || !writable || append.isPending) return;
    void append
      .mutateAsync({ proposalId: randomCorrelationId(), text })
      .then((outcome) => {
        if (outcome.kind === 'committed' || outcome.kind === 'duplicate')
          setDraft('');
      });
  };
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
              {roomRecord(record)}
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
      <label htmlFor={`task-room-message-${id}`}>Message</label>
      <textarea
        id={`task-room-message-${id}`}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        disabled={!writable || append.isPending}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!writable || !draft.trim() || append.isPending}
      >
        Send to task room
      </button>
      {append.isError || (append.data && append.data.kind === 'rejected') ? (
        <p role="alert">
          {append.data?.kind === 'rejected'
            ? `Message rejected: ${append.data.reason}. Draft retained.`
            : 'Message outcome is unavailable. Do not resend until you have checked the room history.'}
        </p>
      ) : null}
    </section>
  );
}
