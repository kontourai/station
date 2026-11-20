import {
  TASK_SHELF_LABELS,
  TASK_SHELVES,
  type TaskLaneDerivation,
  type TaskLaneId,
  type TaskLanePartition,
  type TaskNextAction,
  type TaskShelfId,
} from '@kontourai/station-contracts/task-lane';
import type { TaskListRecord } from '@kontourai/station-sdk';
import {
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isPlainLeftClick } from '../utils/attentionOpen';
import { parseEpochMs } from '../utils/parseEpochMs';
import { relativeTime } from '../utils/relativeTime';
import {
  TASK_LANE_TONE,
  TASK_TONE,
  type TaskStatusPresentation,
} from '../views/project-page/taskStatusPresentation';
import { Button } from './Button';
import { DisclosureToggle } from './DisclosureToggle';
import {
  BranchGlyph,
  PullRequestClosedGlyph,
  PullRequestDraftGlyph,
  PullRequestGlyph,
  PullRequestMergedGlyph,
} from './icons/Glyph';
import { Empty } from './state';
import { LiveStatusGlyph } from './status/LiveStatusGlyph';
import { TaskPlanProgressLine, useTaskPlanProgress } from './TaskPlanProgress';
import './ProjectTaskBoard.css';

/** Moves into these lanes are announced: they ask something of the reader. */
const ANNOUNCED_LANES: ReadonlySet<TaskLaneId> = new Set([
  'needs_you',
  'ready_to_merge',
]);
const ANNOUNCE_INTERVAL_MS = 5_000;

/** A focused element's place on a card, so focus returns to the same one. */
type CardFocus = {
  taskId: string;
  role: 'title' | 'action';
  element: HTMLElement;
};
const ROLE_SELECTOR = {
  title: '.task-card__title',
  action: '.task-card__action button',
} as const;

/** The colour of a tone, as a custom property the stylesheet reads. */
const toneStyle = (tone: keyof typeof TASK_TONE) =>
  ({ '--task-tone': TASK_TONE[tone].color }) as CSSProperties;

export interface ProjectTaskBoardProps {
  partition: TaskLanePartition;
  derivations: ReadonlyMap<string, TaskLaneDerivation>;
  /** Each Task's one status (`taskStatusPresentation`), shared with the list. */
  presentations: ReadonlyMap<string, TaskStatusPresentation>;
  tasks: ReadonlyMap<string, TaskListRecord>;
  /**
   * The facts the lanes depend on have answered. Before then nothing is
   * announced: facts arriving move cards, but no card arrived anywhere.
   */
  settled: boolean;
  /** The checkout branch of the Project, which a Task's branch chip omits. */
  projectBranch?: string;
  /** Tasks whose action is in flight; their button shows it. */
  pendingTaskIds?: ReadonlySet<string>;
  /** Shown above the lanes, such as the pull request wait. */
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
  presentations,
  tasks,
  settled,
  projectBranch,
  pendingTaskIds,
  notice,
  onOpenTask,
  onAction,
}: ProjectTaskBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const focused = useRef<CardFocus | null>(null);
  const announcement = useLaneAnnouncement(partition, tasks, settled);

  // A card that changes lanes is a new element in another list, so the
  // browser drops its focus to the body. Put it back on the same control of
  // the same card, and only then: if the reader has moved focus anywhere
  // else, or the element it was on still exists, nothing is taken.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each new partition, the only render that moves a card.
  useLayoutEffect(() => {
    const last = focused.current;
    const board = boardRef.current;
    if (!last || !board || last.element.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = board.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(last.taskId)}"] ${ROLE_SELECTOR[last.role]}`,
    );
    if (!target) return;
    target.focus();
    focused.current = { ...last, element: target };
  }, [partition]);

  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    const card = element.closest<HTMLElement>('[data-task-id]');
    const taskId = card?.dataset.taskId;
    focused.current = taskId
      ? {
          taskId,
          role: element.closest('.task-card__action') ? 'action' : 'title',
          element,
        }
      : null;
  };
  const forgetFocus = (event: FocusEvent<HTMLDivElement>) => {
    const left = event.target as HTMLElement;
    // Decide once the blur has settled. If the control is still in the page,
    // the reader moved focus away (to another control, or by clicking blank
    // space, which leaves no relatedTarget): forget it, so a later move of
    // the card never pulls focus back. Only a control that vanished (its
    // card moved lanes) is restored. A control that went busy (disabled
    // while its action runs) loses focus without the reader choosing to
    // leave, so it stays remembered.
    queueMicrotask(() => {
      if (
        left.isConnected &&
        !left.matches(':disabled') &&
        focused.current?.element === left
      )
        focused.current = null;
    });
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
          presentation={
            presentations.get(taskId) ?? {
              word: derivation.word,
              tone: derivation.tone,
            }
          }
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
      onBlurCapture={forgetFocus}
    >
      {notice}
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
                  style={toneStyle(TASK_LANE_TONE[lane.id])}
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
                <Empty
                  label="Nothing here"
                  className="project-task-board__nothing"
                />
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
  const [open, setOpen] = useState(false);
  const regionId = `project-task-shelf-${shelf}`;
  if (!total) return null;
  const count =
    total > taskIds.length ? `${taskIds.length} of ${total}` : String(total);
  return (
    <section className="project-task-board__shelf" data-shelf={shelf}>
      <DisclosureToggle
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
        controls={regionId}
      >
        {TASK_SHELF_LABELS[shelf]}{' '}
        <span className="project-task-board__count">{count}</span>
      </DisclosureToggle>
      <ul className="project-task-board__cards" id={regionId} hidden={!open}>
        {open ? children : null}
      </ul>
    </section>
  );
}

function StatusSlot({ derivation }: { derivation: TaskLaneDerivation }) {
  const glyph = derivation.statusGlyph;
  return (
    <span className="task-card__status" data-glyph={glyph} aria-hidden="true">
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
  presentation,
  projectBranch,
  pending,
  onOpenTask,
  onAction,
}: {
  task: TaskListRecord;
  derivation: TaskLaneDerivation;
  presentation: TaskStatusPresentation;
  projectBranch?: string;
  pending: boolean;
  onOpenTask(taskId: string): void;
  onAction(taskId: string, action: TaskNextAction): void;
}) {
  const running =
    derivation.placement.kind === 'lane' &&
    derivation.placement.lane === 'running';
  const plan = useTaskPlanProgress(derivation.evidence.sessionId, {
    running,
  });
  const reasonId = useId();
  const now = Date.now();
  const { word, detail, tone, reason } = presentation;
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
  const feedbackNote = derivation.feedbackNote;
  const feedbackAt = parseEpochMs(feedbackNote?.at);
  // State each fact once: the status line already names a lone PR.
  const detailNamesPullRequest =
    shownPullRequest !== undefined &&
    pullRequests.length === 1 &&
    detail === `#${shownPullRequest.ref}`;
  const action = derivation.nextAction;

  return (
    <article
      className="task-card"
      data-task-id={task.id}
      data-rung={derivation.rung}
      data-tone={tone}
      data-colors-word={TASK_TONE[tone].colorsWord ? 'true' : undefined}
      style={toneStyle(tone)}
    >
      <div className="task-card__header">
        <StatusSlot derivation={{ ...derivation, tone }} />
        <a
          className="task-card__title"
          href={href}
          aria-describedby={reason ? reasonId : undefined}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            onOpenTask(task.id);
          }}
        >
          {task.title}
        </a>
      </div>
      <p className="task-card__status-line">
        <span className="task-card__word">{word}</span>
        {detail ? <span className="task-card__detail"> · {detail}</span> : null}
        {feedbackNote ? (
          // What agent feedback is doing for this pull request; never a lane.
          <span className="task-card__detail">
            {' · '}
            {feedbackNote.text}
            {feedbackAt !== undefined
              ? ` ${relativeTime(feedbackAt, now)}`
              : null}
          </span>
        ) : null}
        {derivation.certainty === 'partial' ? (
          <span className="sr-only">, some facts could not be read</span>
        ) : null}
      </p>
      {reason ? (
        // Why: the PR's title, a failure's cause, why it could not be read.
        // Real text, one muted line, above the card's stretched link.
        <p className="task-card__reason" id={reasonId} title={reason}>
          {reason}
        </p>
      ) : null}
      {plan && running ? <TaskPlanProgressLine progress={plan} /> : null}
      <div className="task-card__footer">
        <p className="task-card__meta">
          {shownPullRequest && !detailNamesPullRequest ? (
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
  settled: boolean,
) {
  const [message, setMessage] = useState('');
  const previous = useRef<Map<string, TaskLaneId> | null>(null);
  const lastAt = useRef(0);
  useEffect(() => {
    // Until the facts answer, there is no baseline: the first settled
    // partition is the board as it is, not a set of arrivals.
    if (!settled) {
      previous.current = null;
      return;
    }
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
  }, [partition, tasks, settled]);
  return message;
}
