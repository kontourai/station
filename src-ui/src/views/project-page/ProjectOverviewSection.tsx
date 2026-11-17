import type { TaskPullRequestFact } from '@kontourai/station-contracts/task-lane';
import {
  type TaskOverviewGroup,
  type TaskOverviewPlacement,
  taskOverviewAutoResolveDays,
} from '@kontourai/station-contracts/task-overview';
import {
  type TaskListRecord,
  TaskOverviewReopenUnsupportedError,
  useReopenTaskOnOverviewMutation,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import { useMemo, useState } from 'react';
import { ActionOverflowMenu } from '../../components/ActionOverflowMenu';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { ErrorState, SkeletonList } from '../../components/state';
import { useAgents } from '../../contexts/AgentsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import { useOpenPullRequestInRegion } from '../../contexts/useOpenInRegion';
import { errorText } from '../../utils/errorText';
import { relativeTimeAgoFromIso } from '../../utils/relativeTime';
import { projectOverviewGroups } from './project-overview-model';
import { useProjectOverviewPreview } from './projectOverviewPreview';
import { TASK_TONE } from './taskStatusPresentation';
import { useTaskBoardModel } from './useTaskBoardModel';
import './ProjectOverviewSection.css';

/**
 * The checks line a pull request link carries, from the readiness the forge
 * reported. Nothing is printed for a readiness that says nothing about checks.
 */
function checksWord(fact: TaskPullRequestFact): string | undefined {
  if (fact.status.state !== 'current') return 'Status unavailable';
  if (fact.status.pullRequestState === 'MERGED') return 'Merged';
  if (fact.status.pullRequestState === 'CLOSED') return 'Closed';
  switch (fact.status.readiness) {
    case 'clean':
      return 'Checks passed';
    case 'checks-not-passing':
      return 'Checks not passing';
    case 'conflicting':
      return 'Conflicts with base';
    case 'behind':
      return 'Behind base';
    case 'blocked':
      return 'Blocked by rules';
    default:
      return undefined;
  }
}

/**
 * The Project Overview (#5064): every Task under what it needs next —
 * Waiting on you, Ready for review, Working, Landing, Idle, Resolved. The
 * groups are the contract's projection (`task-overview`) over the Tasks
 * board's own read model, so a Task's group and its board lane come from
 * the same facts. Resolved is folded by default.
 */
export function ProjectOverviewSection(props: ProjectOverviewSectionProps) {
  // The `project-overview` Feature Preview: off renders nothing and reads
  // nothing.
  return useProjectOverviewPreview() ? (
    <ProjectOverviewGroups {...props} />
  ) : null;
}

interface ProjectOverviewSectionProps {
  slug: string;
  projectId?: string;
  autoResolveDays?: number;
}

function ProjectOverviewGroups({
  slug,
  projectId,
  autoResolveDays: storedAutoResolveDays,
}: ProjectOverviewSectionProps) {
  const { navigate } = useNavigation();
  const agents = useAgents();
  const openPullRequest = useOpenPullRequestInRegion();
  const reopen = useReopenTaskOnOverviewMutation();
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const {
    data: tasks = [],
    error: tasksError,
    refetch: refetchTasks,
    isSuccess: tasksLoaded,
  } = useTasksQuery(slug);
  const board = useTaskBoardModel({
    projectSlug: slug,
    tasks,
    tasksSettled: tasksLoaded,
    agents,
    readPullRequests: true,
  });
  const autoResolveDays = taskOverviewAutoResolveDays(storedAutoResolveDays);
  const now = Date.now();
  // `now` moves a Task only across the quiet period, measured in days.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const { groups, placements } = useMemo(
    () =>
      projectOverviewGroups({
        tasks,
        derivations: board.derivations,
        autoResolveDays,
        now,
      }),
    [tasks, board.derivations, autoResolveDays],
  );
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  if (tasksError && !tasksLoaded)
    return (
      <section className="project-overview" aria-label="Tasks by next step">
        <ErrorState
          variant="compact"
          title="Could not load Tasks"
          description={errorText(tasksError)}
          action={
            <Button onClick={() => void refetchTasks()}>Retry Tasks</Button>
          }
        />
      </section>
    );
  if (board.status === 'loading')
    return (
      <section className="project-overview" aria-label="Tasks by next step">
        <SkeletonList count={3} label="Loading Tasks" />
      </section>
    );
  if (!groups.some((group) => group.total > 0)) return null;

  async function reopenTask(task: TaskListRecord) {
    try {
      await reopen.mutateAsync({ taskId: task.id });
      toastStore.show(`Reopened ${task.title}`);
    } catch (error) {
      toastStore.show(
        error instanceof TaskOverviewReopenUnsupportedError
          ? 'Update this Station to reopen Tasks here.'
          : `Could not reopen: ${errorText(error)}`,
      );
    }
  }

  function openPull(fact: TaskPullRequestFact) {
    const opened = openPullRequest?.(
      {
        host: fact.host,
        owner: fact.repository.owner,
        repository: fact.repository.name,
        ref: fact.ref,
      },
      projectId ?? null,
    );
    if (opened?.ok) return;
    if (fact.url) window.open(fact.url, '_blank', 'noopener,noreferrer');
    else toastStore.show('This pull request can’t be opened here.');
  }

  function renderRow(taskId: string) {
    const task = tasksById.get(taskId);
    const placement = placements.get(taskId);
    const derivation = board.derivations.get(taskId);
    if (!task || !placement || !derivation) return null;
    return (
      <ProjectOverviewRow
        key={taskId}
        task={task}
        placement={placement}
        tone={board.presentations.get(taskId)?.tone ?? derivation.tone}
        agentName={
          task.agentId
            ? (agents.find((agent) => agent.slug === task.agentId)?.name ??
              task.agentId)
            : undefined
        }
        pullRequest={derivation.evidence.pullRequests[0]}
        now={now}
        onOpen={() => navigate(`/tasks/${encodeURIComponent(task.id)}`)}
        onOpenPullRequest={openPull}
        onReopen={() => void reopenTask(task)}
        reopening={reopen.isPending && reopen.variables?.taskId === taskId}
      />
    );
  }

  function renderGroup(group: TaskOverviewGroup) {
    if (group.total === 0) return null;
    const headingId = `project-overview-${group.id}`;
    if (group.id === 'resolved') {
      const listId = `${headingId}-list`;
      return (
        <div
          key={group.id}
          className="project-overview__group project-overview__group--resolved"
        >
          <DisclosureToggle
            id={headingId}
            className="project-overview__resolved-toggle"
            expanded={resolvedOpen}
            onToggle={() => setResolvedOpen((open) => !open)}
            controls={listId}
          >
            {group.label} · {group.total}
          </DisclosureToggle>
          {resolvedOpen && (
            <ul
              id={listId}
              className="project-overview__rows"
              aria-labelledby={headingId}
            >
              {group.taskIds.map(renderRow)}
            </ul>
          )}
        </div>
      );
    }
    return (
      <div
        key={group.id}
        className={`project-overview__group project-overview__group--${group.id}`}
      >
        <h3 id={headingId} className="project-overview__heading">
          {group.label}
          <span className="project-overview__count">{group.total}</span>
        </h3>
        <ul className="project-overview__rows" aria-labelledby={headingId}>
          {group.taskIds.map(renderRow)}
        </ul>
      </div>
    );
  }

  return (
    <section
      className="project-overview"
      aria-labelledby="project-overview-title"
    >
      <div className="project-page__section-header">
        <span
          id="project-overview-title"
          className="project-page__section-label"
        >
          Tasks
        </span>
        {board.pullRequests.failed && (
          <Button onClick={() => board.pullRequests.refetch()}>
            Retry PR status
          </Button>
        )}
      </div>
      {groups.map(renderGroup)}
    </section>
  );
}

function ProjectOverviewRow({
  task,
  placement,
  tone,
  agentName,
  pullRequest,
  now,
  onOpen,
  onOpenPullRequest,
  onReopen,
  reopening,
}: {
  task: TaskListRecord;
  placement: TaskOverviewPlacement;
  tone: keyof typeof TASK_TONE;
  agentName?: string;
  pullRequest?: TaskPullRequestFact;
  now: number;
  onOpen(): void;
  onOpenPullRequest(fact: TaskPullRequestFact): void;
  onReopen(): void;
  reopening: boolean;
}) {
  const checks = pullRequest ? checksWord(pullRequest) : undefined;
  const when = placement.lastActivityAt
    ? relativeTimeAgoFromIso(placement.lastActivityAt, now)
    : undefined;
  return (
    <li className="project-overview__row">
      <button type="button" className="project-overview__open" onClick={onOpen}>
        <span className="project-overview__title">{task.title}</span>
        <span className="project-overview__meta">
          {agentName && (
            <span className="project-overview__agent">{agentName}</span>
          )}
          {when && <span>{when}</span>}
        </span>
        {task.latestReport && (
          <span className="project-overview__report">
            {task.latestReport.text}
          </span>
        )}
      </button>
      <span className="project-overview__trailing">
        <StatusBadge
          tone={TASK_TONE[tone].badge}
          status={
            placement.note === 'not-queued'
              ? `${placement.word} · Not queued`
              : placement.word
          }
        />
        {pullRequest && (
          <button
            type="button"
            className="project-overview__pull-request"
            onClick={() => onOpenPullRequest(pullRequest)}
          >
            #{pullRequest.ref}
            {checks ? ` · ${checks}` : ''}
          </button>
        )}
        {placement.autoResolved && (
          <ActionOverflowMenu
            label={`More actions for ${task.title}`}
            actions={[
              {
                key: 'reopen',
                label: 'Reopen',
                disabled: reopening,
                onSelect: onReopen,
              },
            ]}
          />
        )}
      </span>
    </li>
  );
}
