import { useLayoutEffect } from 'react';
import { Button } from '../components/Button';
import { RoomAvatar } from '../components/room/RoomAvatar';
import {
  browserEpochMs,
  emitRoomPresenceCommitPerformanceMark,
} from '../performance/interactive-workspace-performance-hooks';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';

export function projectTaskRoomEditorPaneId(taskId: string): string {
  return `task-room-editor:${taskId}`;
}

export function ProjectTaskRoomPresence({
  taskId,
  compact = false,
  showMembers = false,
}: {
  taskId: string;
  compact?: boolean;
  showMembers?: boolean;
}) {
  const room = useProjectTaskRoomContext(taskId);
  const published = room?.live?.participants.filter(
    (participant) =>
      participant.publication === 'published' &&
      (!compact || showMembers || participant.actor.standing !== 'member'),
  );
  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    if (!room?.ownActorId || !published) return;
    emitRoomPresenceCommitPerformanceMark({
      taskId,
      viewerActorId: room.ownActorId,
      participantActorIds: published
        .map((participant) => participant.actor.actorId)
        .sort(),
      committedEpochMs: browserEpochMs(),
    });
  }, [published, room?.ownActorId, taskId]);
  return (
    <section
      className={compact ? 'task-room-avatars' : 'task-room-here'}
      aria-label={compact ? 'Present in this Task' : 'Here now'}
      data-station-performance-surface="task-room-presence"
      data-viewer-actor-id={room?.ownActorId}
    >
      {!compact && <h3>Here now</h3>}
      <ul aria-label="Live room participants">
        {published?.map((participant) => (
          <li
            key={participant.actor.actorId}
            data-actor-id={participant.actor.actorId}
            title={participant.actor.label}
          >
            <RoomAvatar
              name={participant.actor.label}
              agent={participant.actor.kind === 'agent'}
            />
            {compact && (
              <span className="sr-only">{participant.actor.label}</span>
            )}
            {!compact && (
              <span>
                {participant.actor.label}
                {participant.actor.kind === 'agent'
                  ? ` · ${participant.work.workState}`
                  : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
      {room?.presenceError && (
        <p className="task-room-inline-status" role="alert">
          {room.presenceError}{' '}
          <Button variant="ghost" size="sm" onClick={room.retryPresence}>
            Retry
          </Button>
        </p>
      )}
      {!compact && !room?.presenceError && !published?.length && (
        <p role="status">
          {room?.stream === 'terminal'
            ? 'Presence unavailable. Reconnect to this Task.'
            : room?.stream === 'live'
              ? 'No published participants yet.'
              : 'Connecting…'}
        </p>
      )}
    </section>
  );
}
