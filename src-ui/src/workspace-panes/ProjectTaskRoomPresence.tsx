import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useLayoutEffect, useState } from 'react';
import {
  browserEpochMs,
  emitRoomPresenceCommitPerformanceMark,
} from '../performance/interactive-workspace-performance-hooks';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';

export function projectTaskRoomEditorPaneId(taskId: string): string {
  return `task-room-editor:${taskId}`;
}

/** Browser projection of the live commands the Task-room contract actually exposes. */
export function ProjectTaskRoomPresence({ taskId }: { taskId: string }) {
  const room = useProjectTaskRoomContext(taskId);
  const [error, setError] = useState<string>();
  const live = room?.live;
  const paneId = projectTaskRoomEditorPaneId(taskId);
  const currentActorId = room?.ownActorId;
  const ownParticipant = currentActorId
    ? live?.participants.find(
        (participant) => participant.actor.actorId === currentActorId,
      )
    : undefined;
  const published = live?.participants.filter(
    (participant) => participant.publication === 'published',
  );
  const pane = live?.panes.find(
    (candidate) =>
      candidate.paneId === paneId && candidate.actorId === currentActorId,
  );
  const target = pane?.targetActorId
    ? live?.participants.find(
        (participant) => participant.actor.actorId === pane.targetActorId,
      )
    : undefined;

  async function command(
    value: Parameters<NonNullable<typeof room>['command']>[0],
  ) {
    if (!room) return;
    try {
      const result = await room.command(value);
      if (result.kind !== 'available') {
        setError('Live collaboration is unavailable.');
        return;
      }
      const receipt = result.snapshot.result;
      if (!receipt) {
        setError('Station could not confirm this live collaboration action.');
        return;
      }
      switch (receipt.outcome) {
        case 'joined':
        case 'refreshed':
        case 'updated':
        case 'cleared':
        case 'departed':
        case 'paused':
          setError(undefined);
          break;
        case 'rate_limited':
          setError('Live collaboration is busy. Wait before trying again.');
          break;
        case 'capacity_exceeded':
          setError('The live room has reached its capacity.');
          break;
        case 'forbidden':
        case 'identity_changed':
          setError(
            'Your access to this live room changed. Refresh before trying again.',
          );
          break;
        case 'invalid':
          setError('This live collaboration action could not be accepted.');
          break;
        case 'unavailable':
          setError('Live collaboration is unavailable.');
          break;
        case 'degraded':
          setError(
            receipt.state === 'indeterminate'
              ? 'Station could not confirm this live collaboration action.'
              : 'This live collaboration action was not accepted.',
          );
          break;
      }
    } catch {
      setError('Live collaboration could not be updated.');
    }
  }

  const liveAvailable =
    room?.discovery.data?.kind === 'opened' ||
    room?.discovery.data?.kind === 'existing'
      ? room.discovery.data.capabilities.live
      : false;
  const streamCopy =
    room?.stream === 'terminal'
      ? 'Live room authorization ended. The last published presence remains visible but cannot be changed.'
      : room?.stream === 'live'
        ? 'Live room connected.'
        : 'Connecting to the live room.';
  const actionsDisabled =
    !liveAvailable || room?.stream === 'terminal' || room?.commandPending;

  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    if (!currentActorId || !published) return;
    emitRoomPresenceCommitPerformanceMark({
      taskId,
      viewerActorId: currentActorId,
      participantActorIds: published
        .map((participant) => participant.actor.actorId)
        .sort(),
      committedEpochMs: browserEpochMs(),
    });
  }, [currentActorId, published, taskId]);

  return (
    <section
      className="project-task-room-presence"
      aria-label="Live collaboration"
      data-station-performance-surface="task-room-presence"
      data-viewer-actor-id={currentActorId}
    >
      <header>
        <h2>Live collaboration</h2>
        <p role="status">{streamCopy}</p>
      </header>
      <div>
        <button
          type="button"
          disabled={actionsDisabled}
          onClick={() => void command({ command: 'join' })}
        >
          Join room
        </button>
        <button
          type="button"
          disabled={actionsDisabled || !ownParticipant}
          onClick={() => void command({ command: 'announce' })}
        >
          Announce work
        </button>
        <button
          type="button"
          disabled={actionsDisabled || !ownParticipant}
          onClick={() => void command({ command: 'depart' })}
        >
          Leave room
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {pane ? (
        <p role="status">
          {pane.state === 'following' ? 'Following' : 'Watching'}{' '}
          {target?.actor.label ?? 'participant'}.
        </p>
      ) : null}
      <ul aria-label="Live room participants">
        {published?.map((participant) => (
          <li
            key={participant.actor.actorId}
            data-actor-id={participant.actor.actorId}
          >
            <strong>
              {participant.actor.kind === 'agent' ? 'Agent' : 'Human'}{' '}
              {participant.actor.label}
            </strong>{' '}
            <span>{participant.work.workName}</span>
            {participant.actor.kind === 'agent' ? (
              <span>
                <a
                  href={activityDeepLink({
                    sessionId: participant.work.sessionId,
                  })}
                >
                  View agent session
                </a>
                {participant.work.runId ? (
                  <a
                    href={`/projects/${encodeURIComponent(live?.scope.projectId ?? '')}/flow-console?run=${encodeURIComponent(participant.work.runId)}`}
                  >
                    View agent run
                  </a>
                ) : null}
              </span>
            ) : null}
            {participant.actor.actorId !== currentActorId ? (
              <span>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() =>
                    void command({
                      command: 'watch',
                      paneId,
                      targetActorId: participant.actor.actorId,
                    })
                  }
                >
                  Watch {participant.actor.label}
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() =>
                    void command({
                      command: 'follow',
                      paneId,
                      targetActorId: participant.actor.actorId,
                    })
                  }
                >
                  Follow {participant.actor.label}
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {!published?.length ? <p>Awaiting published participants.</p> : null}
      {pane ? (
        <button
          type="button"
          disabled={actionsDisabled}
          onClick={() => void command({ command: 'stop', paneId })}
        >
          Stop watching
        </button>
      ) : null}
    </section>
  );
}
