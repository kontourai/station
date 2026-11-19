import {
  type CoordinatorTaskState,
  PROJECT_ROOM_COORDINATOR_PREVIEW_ID,
  type ProjectRoomCoordinatorProposal,
  type ProjectRoomCoordinatorTask,
} from '@kontourai/station-contracts/project-room-coordinator';
import { SESSION_STATUS_WORDS } from '@kontourai/station-contracts/session-attention';
import {
  useProjectRoomCoordinator,
  useProjectRoomCoordinatorCapability,
  useProjectRoomStatusSweep,
  useStartProjectRoomCoordinatorTasks,
} from '@kontourai/station-sdk/project-room-coordinator';
import type { ApiRequestScope } from '@kontourai/station-sdk/project-rooms';
import { Badge, type SemanticTone } from '@kontourai/ui/react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { userFacingErrorMessage } from '../../utils/errorText';
import './ProjectRoomCoordinator.css';

/** What the coordinator's card and bar need from the room on screen. */
export interface RoomCoordinatorPorts {
  requestScope: ApiRequestScope;
  slug: string;
  guards: {
    expectedRoomId: string;
    expectedProjectId: string;
    expectedActorId: string;
  };
  /** The person may start work here (the room's execute action). */
  canStart: boolean;
}

/**
 * #5063: whether `#general` on screen has a coordinator: its preview is on
 * and the host serves its routes.
 */
export function useRoomCoordinatorEnabled(general: boolean): boolean {
  const preview = useSurfaceVisibilityFlags().has(
    PROJECT_ROOM_COORDINATOR_PREVIEW_ID,
  );
  // Asked only where it can matter, so a room without the preview reads
  // nothing more.
  const capability = useProjectRoomCoordinatorCapability(general && preview);
  return general && preview && capability.data === true;
}

const STATES: Record<
  CoordinatorTaskState,
  { word: string; tone: SemanticTone }
> = {
  proposed: { word: 'Proposed', tone: 'neutral' },
  waiting: { word: 'Waiting for a slot', tone: 'caution' },
  starting: { word: 'Starting', tone: 'active' },
  working: { word: 'Working', tone: 'active' },
  done: { word: SESSION_STATUS_WORDS.done, tone: 'positive' },
  failed: { word: 'Stopped', tone: 'negative' },
  refused: { word: 'Not started', tone: 'negative' },
};

function placementLabel(task: ProjectRoomCoordinatorTask) {
  return task.placement === 'worktree' ? 'Own worktree' : 'Project folder';
}

function CoordinatorTaskRow({
  task,
  canStart,
  starting,
  onStart,
}: {
  task: ProjectRoomCoordinatorTask;
  canStart: boolean;
  starting: boolean;
  onStart(): void;
}) {
  const { navigate } = useNavigation();
  const state = STATES[task.state];
  return (
    <li className="room-coordinator-card__row">
      <div className="room-coordinator-card__main">
        <span className="room-coordinator-card__title">{task.title}</span>
        <span className="room-coordinator-card__meta">
          {task.agentLabel} · {placementLabel(task)}
          {task.mayOpenPullRequest ? ' · May open a pull request' : ''}
        </span>
        {task.refusal && (
          <span className="room-coordinator-card__note">{task.refusal}</span>
        )}
        {task.pullRequestRefusals > 0 && (
          <span className="room-coordinator-card__note">
            Station refused{' '}
            {task.pullRequestRefusals === 1
              ? 'a pull request'
              : `${task.pullRequestRefusals} pull requests`}{' '}
            you did not ask for.
          </span>
        )}
      </div>
      <div className="room-coordinator-card__side">
        <Badge tone={state.tone} value={state.word} />
        {task.state === 'proposed' && canStart && (
          <Button
            size="sm"
            disabled={starting}
            aria-label={`Start ${task.title}`}
            onClick={onStart}
          >
            Start
          </Button>
        )}
        {task.taskId && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Open Task ${task.title}`}
            onClick={() =>
              navigate(`/tasks/${encodeURIComponent(task.taskId!)}`)
            }
          >
            Open Task
          </Button>
        )}
      </div>
    </li>
  );
}

function CoordinatorTaskCard({
  proposal,
  ports,
}: {
  proposal: ProjectRoomCoordinatorProposal;
  ports: RoomCoordinatorPorts;
}) {
  const start = useStartProjectRoomCoordinatorTasks(
    ports.requestScope,
    ports.slug,
    ports.guards,
  );
  const proposed = proposal.tasks.filter((task) => task.state === 'proposed');
  return (
    <section
      className="room-coordinator-card"
      aria-label={`Suggested Tasks, ${proposal.tasks.length}`}
    >
      <ul className="room-coordinator-card__rows">
        {proposal.tasks.map((task) => (
          <CoordinatorTaskRow
            key={task.rowId}
            task={task}
            canStart={ports.canStart}
            starting={start.isPending}
            onStart={() =>
              start.mutate({
                proposalId: proposal.proposalId,
                rowIds: [task.rowId],
              })
            }
          />
        ))}
      </ul>
      {ports.canStart && proposed.length > 1 && (
        <div className="room-coordinator-card__footer">
          <Button
            size="sm"
            disabled={start.isPending}
            onClick={() => start.mutate({ proposalId: proposal.proposalId })}
          >
            Start all {proposed.length}
          </Button>
        </div>
      )}
      {start.error && (
        <ErrorState
          variant="compact"
          title="These Tasks did not start"
          description={userFacingErrorMessage(start.error)}
          action={
            <Button size="sm" onClick={() => start.reset()}>
              Dismiss
            </Button>
          }
        />
      )}
    </section>
  );
}

/**
 * The suggested-Tasks card under the coordinator message that proposed
 * them. Every card shares one query, so many messages cost one read.
 */
export function RoomCoordinatorCard({
  messageId,
  ports,
}: {
  messageId: string;
  ports: RoomCoordinatorPorts;
}) {
  const query = useProjectRoomCoordinator(ports.requestScope, ports.slug, true);
  const proposal = query.data?.proposals.find(
    (candidate) => candidate.messageId === messageId,
  );
  return proposal ? (
    <CoordinatorTaskCard proposal={proposal} ports={ports} />
  ) : null;
}

/**
 * `#general`'s coordinator bar: how many Tasks are working and waiting
 * against the Project's limit, and the status sweep.
 */
export function RoomCoordinatorBar({ ports }: { ports: RoomCoordinatorPorts }) {
  const query = useProjectRoomCoordinator(ports.requestScope, ports.slug, true);
  const sweep = useProjectRoomStatusSweep(
    ports.requestScope,
    ports.slug,
    ports.guards,
  );
  const view = query.data;
  return (
    <section className="room-coordinator-bar" aria-label="Coordinator">
      <span className="room-coordinator-bar__status" role="status">
        {query.isError
          ? 'Coordinator unavailable'
          : view
            ? `${view.working} working · ${view.waiting} waiting · up to ${view.settings.maxConcurrentTasks} at once`
            : 'Loading coordinator…'}
      </span>
      {query.isError ? (
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Retry
        </Button>
      ) : (
        ports.canStart && (
          <Button
            size="sm"
            variant="ghost"
            disabled={sweep.isPending || !view}
            onClick={() => sweep.mutate()}
          >
            {sweep.isPending ? 'Checking Tasks…' : 'Status sweep'}
          </Button>
        )
      )}
      {sweep.error && (
        <ErrorState
          variant="compact"
          title="The status sweep did not run"
          description={userFacingErrorMessage(sweep.error)}
          action={
            <Button size="sm" onClick={() => sweep.mutate()}>
              Retry
            </Button>
          }
        />
      )}
    </section>
  );
}
