import {
  TASK_SHELF_LABELS,
  TASK_SHELVES,
  type TaskLaneDerivation,
  type TaskLaneId,
  type TaskLanePartition,
  type TaskNextAction,
  type TaskShelfId,
} from '@kontourai/station-contracts/task-lane';
import type {
  OrchestrationSessionSummary,
  TaskListRecord,
} from '@kontourai/station-sdk';
import {
  type FocusEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { AgentSummary } from '../types';
import { isPlainLeftClick } from '../utils/attentionOpen';
import { parseEpochMs } from '../utils/parseEpochMs';
import { relativeTime } from '../utils/relativeTime';
import { sessionWorkStatus } from '../views/sessions/sessions-lane-model';
import { Button } from './Button';
import {
  BranchGlyph,
  PullRequestClosedGlyph,
  PullRequestDraftGlyph,
  PullRequestGlyph,
  PullRequestMergedGlyph,
} from './icons/Glyph';
import { LiveStatusGlyph } from './status/LiveStatusGlyph';
import { TaskPlanProgressLine, useTaskPlanProgress } from './TaskPlanProgress';
import './ProjectTaskBoard.css';

/** Moves into these lanes are announced: they ask something of the reader. */
const ANNOUNCED_LANES: ReadonlySet<TaskLaneId> = new Set([
  'needs_you',
  'ready_to_merge',
]);
const ANNOUNCE_INTERVAL_MS = 5_000;

/** Rungs whose words come from the run itself, refined by the ladder. */
const SESSION_RUNGS: ReadonlySet<TaskLaneDerivation['rung']> = new Set([
  'approval',
  'answer',
  'interrupted',
  'blocked',
  'waiting',
  'failed',
  'running',
  'elsewhere',
]);

export interface ProjectTaskBoardProps {
  partition: TaskLanePartition;
  derivations: ReadonlyMap<string, TaskLaneDerivation>;
  tasks: ReadonlyMap<string, TaskListRecord>;
  sessionsById: ReadonlyMap<string, OrchestrationSessionSummary>;
  agents: AgentSummary[];
  /** The checkout branch of the Project, which a Task's branch chip omits. */
  projectBranch?: string;
  /** Tasks whose action is in flight; their button shows it. */
  pendingTaskIds?: ReadonlySet<string>;
  /** A line under the lanes' headers, such as "Checking pull requests…". */
  notice?: ReactNode;
  onOpenTask(taskId: string): void;
  onAction(taskId: string, action: TaskNextAction): void;
}

/**
 * The Project Tasks board (derived Task lanes): five live lanes, always all
 * shown, and the intent shelves under them. Every word, lane and action on
 * it comes from the contract's derivation; this component only lays it out,
 * keeps focus on a card that moves, and announces arrivals that ask for the
 * reader.
 */
export function ProjectTaskBoard({
  partition,
  derivations,
  tasks,
  sessionsById,
  agents,
  projectBranch,
  pendingTaskIds,
  notice,
  onOpenTask,
  onAction,
}: ProjectTaskBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const focusedTaskId = useRef<string | null>(null);
  const announcement = useLaneAnnouncement(partition, tasks);

  // A card that changes lanes is a new element in another list, so the
  // browser drops its focus to the body. Put it back on the same card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each new partition, the only render that moves a card.
  useLayoutEffect(() => {
    const taskId = focusedTaskId.current;
    const board = boardRef.current;
    if (!taskId || !board) return;
    // Only when focus was dropped: never take it from where the reader is.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const card = board.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(taskId)}"] .task-card__title`,
    );
    card?.focus();
  }, [partition]);

  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-task-id]',
    );
    focusedTaskId.current = card?.dataset.taskId ?? null;
  };

  const card = (taskId: string) => {
    const derivation = derivations.get(taskId);
    const task = tasks.get(taskId);
    if (!derivation || !task) return null;
    return (
      <li key={taskId}>
        <TaskCard
          task={task}
          derivation={derivation}
          session={
            derivation.evidence.sessionId
              ? sessionsById.get(derivation.evidence.sessionId)
              : undefined
          }
          agents={agents}
          projectBranch={projectBranch}
          pending={pendingTaskIds?.has(taskId) ?? false}
          onOpenTask={onOpenTask}
          onAction={onAction}
        />
      </li>
    );
  };

  return (
    <div
      className="project-task-board"
      ref={boardRef}
      onFocusCapture={rememberFocus}
    >
      {notice ? <p className="project-task-board__notice">{notice}</p> : null}
      <div className="project-task-board__lanes">
        {partition.lanes.map((lane) => {
          const headingId = `project-task-lane-${lane.id}`;
          return (
            <section
              key={lane.id}
              className="project-task-board__lane"
              data-lane={lane.id}
              data-empty={lane.taskIds.length === 0 ? 'true' : undefined}
              aria-labelledby={headingId}
            >
              <h3 className="project-task-board__lane-header" id={headingId}>
                <span
                  className="project-task-board__lane-dot"
                  aria-hidden="true"
                />
                <span>{lane.label}</span>
                <span className="project-task-board__count">
                  {lane.taskIds.length}
                </span>
              </h3>
              {lane.taskIds.length ? (
                <ul className="project-task-board__cards">
                  {lane.taskIds.map(card)}
                </ul>
              ) : (
                <p className="project-task-board__empty">Nothing here</p>
              )}
            </section>
          );
        })}
      </div>
      <div className="project-task-board__shelves">
        {TASK_SHELVES.map((shelf) => (
          <TaskShelf
            key={shelf}
            shelf={shelf}
            taskIds={partition.shelves[shelf]}
            total={partition.shelfTotals[shelf]}
          >
            {partition.shelves[shelf].map(card)}
          </TaskShelf>
        ))}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function TaskShelf({
  shelf,
  taskIds,
  total,
  children,
}: {
  shelf: TaskShelfId;
  taskIds: readonly string[];
  total: number;
  children: ReactNode;
}) {
  if (!total) return null;
  const count =
    total > taskIds.length ? `${taskIds.length} of ${total}` : String(total);
  return (
    <details className="project-task-board__shelf" data-shelf={shelf}>
      <summary>
        <span>{TASK_SHELF_LABELS[shelf]}</span>
        <span className="project-task-board__count">{count}</span>
      </summary>
      <ul className="project-task-board__cards">{children}</ul>
    </details>
  );
}

function StatusSlot({ derivation }: { derivation: TaskLaneDerivation }) {
  const glyph = derivation.statusGlyph;
  return (
    <span
      className="task-card__status"
      data-tone={derivation.tone}
      data-glyph={glyph}
      aria-hidden="true"
    >
      {glyph === 'spinner' ? (
        <LiveStatusGlyph kind="working" />
      ) : glyph === 'pr-open' ? (
        <PullRequestGlyph />
      ) : glyph === 'pr-draft' ? (
        <PullRequestDraftGlyph />
      ) : glyph === 'pr-merged' ? (
        <PullRequestMergedGlyph />
      ) : glyph === 'pr-closed' ? (
        <PullRequestClosedGlyph />
      ) : (
        <span className="task-card__dot" />
      )}
    </span>
  );
}

function TaskCard({
  task,
  derivation,
  session,
  agents,
  projectBranch,
  pending,
  onOpenTask,
  onAction,
}: {
  task: TaskListRecord;
  derivation: TaskLaneDerivation;
  session: OrchestrationSessionSummary | undefined;
  agents: AgentSummary[];
  projectBranch?: string;
  pending: boolean;
  onOpenTask(taskId: string): void;
  onAction(taskId: string, action: TaskNextAction): void;
}) {
  const running =
    derivation.placement.kind === 'lane' &&
    derivation.placement.lane === 'running';
  const plan = useTaskPlanProgress(task, { live: running });
  const now = Date.now();
  // The run's own rungs read the status ladder's line, which knows the
  // running tool, sub-agents and a failure's cause. The lane stays the
  // derivation's.
  const ladder =
    session && SESSION_RUNGS.has(derivation.rung)
      ? sessionWorkStatus(session, agents, now)
      : undefined;
  const word = ladder?.word ?? derivation.word;
  const detail = ladder ? ladder.detail : derivation.detail;
  const tone = ladder && running ? ladder.tone : derivation.tone;
  const reason = ladder?.reason ?? derivation.reason;
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const pullRequests = derivation.evidence.pullRequests;
  const shownPullRequest = pullRequests[0];
  const repositories = new Set(
    pullRequests.map(
      (fact) => `${fact.repository.owner}/${fact.repository.name}`,
    ),
  );
  const branch = task.taskWorktree?.branch;
  const showBranch =
    !pullRequests.length && branch !== undefined && branch !== projectBranch;
  const factTime = parseEpochMs(derivation.factTime);
  const action = derivation.nextAction;

  return (
    <article
      className="task-card"
      data-task-id={task.id}
      data-rung={derivation.rung}
      data-tone={tone}
    >
      <div className="task-card__header">
        <StatusSlot derivation={{ ...derivation, tone }} />
        <a
          className="task-card__title"
          href={href}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            onOpenTask(task.id);
          }}
        >
          {task.title}
        </a>
        <span className="task-card__action">
          <Button
            size="sm"
            pending={pending}
            aria-label={`${action.label.replace('…', '')} ${task.title}`}
            onClick={() => onAction(task.id, action)}
          >
            {action.label}
          </Button>
        </span>
      </div>
      <p className="task-card__status-line" title={reason}>
        <span className="task-card__word">{word}</span>
        {detail ? <span className="task-card__detail"> · {detail}</span> : null}
        {derivation.certainty === 'partial' ? (
          <span className="sr-only">, some facts could not be read</span>
        ) : null}
      </p>
      {plan && running ? <TaskPlanProgressLine progress={plan} /> : null}
      <p className="task-card__meta">
        {shownPullRequest ? (
          <span
            className="task-card__evidence"
            title={
              shownPullRequest.status.state === 'current'
                ? shownPullRequest.status.title
                : shownPullRequest.status.reason
            }
          >
            {repositories.size > 1
              ? `${shownPullRequest.repository.owner}/${shownPullRequest.repository.name}`
              : null}
            #{shownPullRequest.ref}
            {pullRequests.length > 1 ? ` +${pullRequests.length - 1}` : null}
          </span>
        ) : null}
        {showBranch ? (
          <span className="task-card__chip">
            <BranchGlyph />
            {branch}
          </span>
        ) : null}
        {task.taskWorktreeUnknown ? (
          <span className="task-card__chip">Worktree unknown</span>
        ) : null}
        {task.taskWorktree?.kept ? (
          <span
            className="task-card__chip"
            title={
              task.taskWorktree.kept.detail ?? task.taskWorktree.kept.reason
            }
          >
            Worktree kept
          </span>
        ) : null}
        {factTime !== undefined ? (
          <span>{relativeTime(factTime, now)}</span>
        ) : null}
        {task.agentId?.trim() ? <span>{task.agentId}</span> : null}
        {task.priority !== 'normal' ? (
          <span className="task-card__priority" data-priority={task.priority}>
            {task.priority}
          </span>
        ) : null}
      </p>
    </article>
  );
}

/**
 * One polite announcement when a Task moves INTO Needs you or Ready to
 * merge, at most once every five seconds. Other moves are silent: the board
 * is read, not narrated.
 */
function useLaneAnnouncement(
  partition: TaskLanePartition,
  tasks: ReadonlyMap<string, TaskListRecord>,
) {
  const [message, setMessage] = useState('');
  const previous = useRef<Map<string, TaskLaneId> | null>(null);
  const lastAt = useRef(0);
  useEffect(() => {
    const current = new Map<string, TaskLaneId>();
    for (const lane of partition.lanes)
      for (const taskId of lane.taskIds) current.set(taskId, lane.id);
    const before = previous.current;
    previous.current = current;
    if (!before) return;
    const arrival = partition.lanes
      .filter((lane) => ANNOUNCED_LANES.has(lane.id))
      .flatMap((lane) =>
        lane.taskIds
          .filter((taskId) => before.get(taskId) !== lane.id)
          .map((taskId) => ({ taskId, label: lane.label })),
      )[0];
    if (!arrival) return;
    const at = Date.now();
    if (at - lastAt.current < ANNOUNCE_INTERVAL_MS) return;
    lastAt.current = at;
    const title = tasks.get(arrival.taskId)?.title ?? 'A Task';
    setMessage(`${title}: ${arrival.label}`);
  }, [partition, tasks]);
  return message;
}
