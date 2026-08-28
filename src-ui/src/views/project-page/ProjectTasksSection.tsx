import type { StartTaskStarterLaunchResult } from '@kontourai/station-contracts/starter-work';
import { resolveWorkflowTaskMatch } from '@kontourai/station-contracts/workflow';
import {
  type GitStatusResult,
  type ProviderWorkItem,
  type RelationGraphLink,
  type TaskRecord,
  taskQueries,
  useCreateTaskMutation,
  useDispatchTaskMutation,
  useLaunchStartTaskStarterMutation,
  useQueryClient,
  useTaskClaimQuery,
  useTaskGraphQuery,
  useTasksQuery,
  useWorkflowTasksQuery,
  useWorkItemClaimQuery,
  useWorkItemsQuery,
} from '@kontourai/station-sdk';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { WorkflowStatusLine } from '../../components/flow/WorkflowStatusLine';
import { describeReadFailure, Empty, ErrorState } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import { browserStarterWorkOperationStore } from '../../lib/starter-work-operation-store';

/** Human-readable label for a claim actor (part of,
 *) — used by both the local-task guard and the provider-item badge. */
function actorLabel(actor: {
  runtime: string;
  sessionId: string;
  human?: string | null;
}): string {
  if (actor.human) return actor.human;
  return `${actor.runtime}:${actor.sessionId}`;
}

function relationLabel(link: RelationGraphLink): string {
  const target =
    link.targetType === 'session'
      ? link.targetId.replace(/^task-/, '')
      : link.targetId;
  return `${link.relationType.replaceAll('_', ' ')} · ${link.targetType}:${target}`;
}

function sortTasks(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const starterWorkOperations = browserStarterWorkOperationStore();

/**
 * A `workItemRef` is only a safe cross-provider join key when it is
 * globally namespaced (contract invariant on
 * `ProviderWorkItem.workItemRef`, e.g. `github:owner/repo#123`) — a bare,
 * unnamespaced id (no `:` separator) from a future backend could otherwise
 * collide with an unrelated local task's ref and false-hide a distinct
 * provider item (archive#583 finding). Namespaced refs join local↔external
 * on purpose (that's the point of the shared vocabulary); unnamespaced ones
 * never participate in the hide/dedupe decision in either direction.
 */
function isNamespacedWorkItemRef(ref: string): boolean {
  return ref.includes(':');
}

/**
 * Provider-backed work items to render alongside local tasks (archive#583, part of
 *). Local-kind provider results are excluded — the local task
 * list above already renders those TaskRecords directly — and any item
 * whose (namespaced) `workItemRef` already matches a local task's
 * `workItemRef` is excluded too, so a task that has already joined its
 * upstream work item doesn't render twice. Read-only this slice: no
 * dispatch/write for these rows (/FA2-post-bump territory).
 */
function externalProviderItems(
  providers: Array<{ identity: { kind: string }; items: ProviderWorkItem[] }>,
  localTasks: TaskRecord[],
): ProviderWorkItem[] {
  const localWorkItemRefs = new Set(
    localTasks.flatMap((task) =>
      task.workItemRef && isNamespacedWorkItemRef(task.workItemRef)
        ? [task.workItemRef]
        : [],
    ),
  );
  return providers
    .filter((provider) => provider.identity.kind !== 'local')
    .flatMap((provider) => provider.items)
    .filter(
      (item) =>
        !item.workItemRef ||
        !isNamespacedWorkItemRef(item.workItemRef) ||
        !localWorkItemRefs.has(item.workItemRef),
    );
}

export function ProjectTasksSection({
  slug,
  projectWorkingDirectory,
  gitStatus,
  agents,
}: {
  slug: string;
  projectWorkingDirectory?: string;
  gitStatus?: GitStatusResult | null;
  agents?: string[];
}) {
  const { navigate } = useNavigation();
  const starterId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('starter')
      : null;
  const [starterLaunchProblem, setStarterLaunchProblem] = useState<
    | 'correlation'
    | 'failed'
    | 'aborted'
    | 'deferred'
    | 'unavailable'
    | 'indeterminate'
    | 'retry-state-corrupt'
    | 'retry-state-unavailable'
    | null
  >(null);
  const [starterLaunchReason, setStarterLaunchReason] = useState('');
  const queryClient = useQueryClient();
  // `= []` alone makes a failed read look like a project with no
  // tasks, so both panes below claimed "No tasks yet." / "Select a task." over
  // a read that never answered.
  const {
    data: tasks = [],
    error: tasksError,
    refetch: refetchTasks,
  } = useTasksQuery(slug);
  const sortedTasks = sortTasks(tasks as TaskRecord[]);
  const [title, setTitle] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedProviderItemId, setSelectedProviderItemId] = useState('');
  const createTaskMutation = useCreateTaskMutation();
  const dispatchTaskMutation = useDispatchTaskMutation();
  const launchStarterMutation = useLaunchStartTaskStarterMutation();
  const starterOperationId = useRef<string | null>(null);
  const selectedTask = sortedTasks.find((task) => task.id === selectedTaskId);
  const { data: taskGraph } = useTaskGraphQuery(selectedTaskId, {
    enabled: selectedTaskId.length > 0,
  });

  // archive#582: resolve the selected task's flow-agents sidecar — durable
  // workItemRef join first, then a collision-guarded title-slug heuristic
  // (suppressed entirely when 2+ project tasks normalize to the same slug).
  // Renders nothing when neither path yields a match.
  // A project can intentionally have no local workspace binding. These
  // sidecars resolve files from that binding, so do not ask their
  // workspace-only endpoints until one exists (archive#1501).
  const hasLocalWorkspace = Boolean(projectWorkingDirectory);
  const { data: workflowTasks = [] } = useWorkflowTasksQuery(slug, {
    enabled: hasLocalWorkspace,
  });
  const workflowMatch = selectedTask
    ? resolveWorkflowTaskMatch(selectedTask, sortedTasks, workflowTasks)
    : undefined;

  // archive#583: provider seam — local backend items render as the task list above
  // (unchanged); provider-backed items from other backends (e.g. the
  // flow-agents-contract GitHub backend) render as additional, visually
  // distinguished rows below them.
  const { data: workItemsData } = useWorkItemsQuery(slug, {
    enabled: hasLocalWorkspace,
  });
  const providerItems = externalProviderItems(
    workItemsData?.providers ?? [],
    sortedTasks,
  );
  const selectedProviderItem = providerItems.find(
    (item) => item.id === selectedProviderItemId,
  );

  // archive#584: AssignmentProvider claim state. The local task's own claim (keyed
  // by taskId, so the guard also knows "claimed by me" vs "by another
  // actor") drives the Dispatch guard; the selected provider item's claim
  // (keyed by its raw workItemRef — it has no local task yet) is
  // read-only/informational, matching that row's existing "dispatch is not
  // available for this item yet" read-only detail pane.
  const { data: taskClaim } = useTaskClaimQuery(selectedTaskId, {
    enabled: Boolean(selectedTask?.workItemRef),
  });
  const { data: providerItemClaim } = useWorkItemClaimQuery(
    slug,
    selectedProviderItem?.workItemRef,
  );

  // Reconcile a stranded selection (archive#583 finding): the 30s
  // useWorkItemsQuery/useTasksQuery refetch can move, dedupe, or drop the
  // currently selected row (provider board movement, a local task deletion,
  // a provider going unavailable). Without this, the detail pane would keep
  // rendering "Select a task" forever once the selected id no longer
  // resolves against the latest data — clear it so the fallback below picks
  // a sane default instead.
  useEffect(() => {
    if (
      selectedTaskId &&
      !sortedTasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId('');
    }
  }, [selectedTaskId, sortedTasks]);

  useEffect(() => {
    if (
      selectedProviderItemId &&
      !providerItems.some((item) => item.id === selectedProviderItemId)
    ) {
      setSelectedProviderItemId('');
    }
  }, [selectedProviderItemId, providerItems]);

  useEffect(() => {
    if (!selectedTaskId && !selectedProviderItemId && sortedTasks[0]) {
      setSelectedTaskId(sortedTasks[0].id);
    }
  }, [selectedTaskId, selectedProviderItemId, sortedTasks]);

  async function invalidateTasks(taskId?: string) {
    await queryClient.invalidateQueries({
      queryKey: taskQueries.list(slug).queryKey,
    });
    if (taskId) {
      await queryClient.invalidateQueries({
        queryKey: taskQueries.graph(taskId).queryKey,
      });
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    const createInput = {
      projectId: slug,
      title: nextTitle,
      agentId: agents?.[0],
      createdBy: 'user',
      workspaceBinding: {
        workingDirectory: projectWorkingDirectory,
        repoRoot: gitStatus?.isRepo ? gitStatus.repoRoot : undefined,
        worktreePath: gitStatus?.isRepo ? gitStatus.repoRoot : undefined,
        branch: gitStatus?.isRepo ? gitStatus.branch : undefined,
        sourceSurface: 'ui',
      },
    };
    if (starterId === 'start-task') {
      setStarterLaunchProblem(null);
      setStarterLaunchReason('');
      const reservation = await starterWorkOperations.reserve(slug);
      if (reservation.state === 'corrupt') {
        setStarterLaunchProblem('retry-state-corrupt');
        return;
      }
      if (reservation.state === 'unavailable') {
        setStarterLaunchProblem('retry-state-unavailable');
        return;
      }
      const operationId = reservation.operationId;
      starterOperationId.current = operationId;
      let launched: StartTaskStarterLaunchResult;
      try {
        launched = await launchStarterMutation.mutateAsync({
          starterId,
          operationId,
          task: createInput,
          dispatch: {
            agentId: agents?.[0],
            runtimeConfig: projectWorkingDirectory
              ? { cwd: projectWorkingDirectory }
              : undefined,
          },
        });
      } catch (error) {
        setStarterLaunchProblem('unavailable');
        setStarterLaunchReason(describeReadFailure(error));
        return;
      }
      if (launched.state !== 'started') {
        setStarterLaunchProblem(launched.state);
        setStarterLaunchReason(launched.reason);
        return;
      }
      setTitle('');
      const cleared = await starterWorkOperations.clear(slug, operationId);
      if (cleared.state === 'cleared') {
        starterOperationId.current = null;
      } else {
        toastStore.show(
          'The Task was created, but this device could not clear its retry state. Reopening Starter Work may return to the same Task.',
          undefined,
          12_000,
        );
      }
      selectLocalTask(launched.task.id);
      await invalidateTasks(launched.task.id);
      if (launched.correlation.state === 'bound') {
        queryClient.setQueryData(['starter-work', starterId], {
          state: 'bound',
          binding: launched.correlation.binding,
        });
      }
      if (launched.correlation.state !== 'bound') {
        setStarterLaunchProblem('correlation');
        setStarterLaunchReason(launched.correlation.reason);
        navigate(`/tasks/${encodeURIComponent(launched.task.id)}`, {
          starter: starterId,
          starterLink: 'not-verified',
        });
        return;
      }
      if (launched.dispatch.state !== 'dispatched') {
        setStarterLaunchProblem(launched.dispatch.state);
        setStarterLaunchReason(launched.dispatch.reason);
        navigate(`/tasks/${encodeURIComponent(launched.task.id)}`, {
          starter: starterId,
          starterLink: 'not-verified',
        });
        return;
      }
      navigate(`/tasks/${encodeURIComponent(launched.task.id)}`);
      return;
    }
    const task = await createTaskMutation.mutateAsync(createInput);
    setTitle('');
    selectLocalTask(task.id);
    await invalidateTasks(task.id);
    navigate(`/tasks/${encodeURIComponent(task.id)}`);
  }

  async function dispatchSelectedTask() {
    if (!selectedTask) return;
    const result = await dispatchTaskMutation.mutateAsync({
      taskId: selectedTask.id,
      dispatch: {
        agentId: selectedTask.agentId,
        skillName: selectedTask.skillName,
        runtimeConfig: projectWorkingDirectory
          ? { cwd: projectWorkingDirectory }
          : undefined,
        sourceSurface: 'project-page',
      },
    });
    selectLocalTask(result.task.id);
    await invalidateTasks(result.task.id);
  }

  function selectLocalTask(taskId: string) {
    setSelectedProviderItemId('');
    setSelectedTaskId(taskId);
  }

  function selectProviderItem(itemId: string) {
    setSelectedTaskId('');
    setSelectedProviderItemId(itemId);
  }

  const links = taskGraph?.links ?? [];
  const binding = selectedTask?.workspaceBinding;

  return (
    <section className="project-page__tasks">
      <div className="project-page__section-header">
        <span className="project-page__section-label">Tasks</span>
      </div>

      <form className="project-page__task-form" onSubmit={createTask}>
        {starterId === 'start-task' && (
          <p role="status">
            Create a focused starter task. Station will link the exact task
            after it is created.
          </p>
        )}
        <input
          className="project-page__task-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Create a task"
          aria-label="Task title"
        />
        <button
          className="project-page__add-btn project-page__add-btn--primary"
          type="submit"
          disabled={
            !title.trim() ||
            createTaskMutation.isPending ||
            launchStarterMutation.isPending
          }
        >
          Add task
        </button>
      </form>
      {/*
        station#3965: these six sentences are what a person reads after
        pressing "Add task", and every one of them used to name the mechanism
        instead of the outcome — "Starter correlation is NOT_VERIFIED",
        "dispatch is indeterminate", "retry state is corrupt". Each now leads
        with what happened to the reader's work, says plainly what we could
        not confirm, and names the one thing they can do next. `NOT_VERIFIED`
        is an internal verification token; it stays on the wire and off the
        screen.
*/}
      {starterLaunchProblem === 'correlation' && (
        <p role="status">
          Your task was created and opened. We couldn’t confirm it is linked to
          your first-task step, so that step may still look unfinished — you can
          link it from the task itself.
        </p>
      )}
      {starterLaunchProblem === 'indeterminate' && (
        <p role="status">
          Your task was created, but we couldn’t tell whether the agent started
          working on it. Open the task to see before starting it again.
        </p>
      )}
      {starterLaunchProblem === 'retry-state-corrupt' && (
        <p role="status">
          Nothing was started. This device’s saved record of your first-task
          setup can’t be read, and Station won’t start work it can’t track.
        </p>
      )}
      {starterLaunchProblem === 'retry-state-unavailable' && (
        <p role="status">
          Nothing was started. This device can’t reach its saved record of your
          first-task setup, and Station won’t start work it can’t track.
        </p>
      )}
      {starterLaunchProblem === 'deferred' && (
        <p role="status">
          Waiting for the agent to be ready. {starterLaunchReason} Try again
          once it is — this picks up the same task rather than making another.
        </p>
      )}
      {starterLaunchProblem &&
        starterLaunchProblem !== 'correlation' &&
        starterLaunchProblem !== 'deferred' &&
        starterLaunchProblem !== 'indeterminate' &&
        starterLaunchProblem !== 'retry-state-corrupt' &&
        starterLaunchProblem !== 'retry-state-unavailable' && (
          <p role="status">
            Station stopped before starting the work ({starterLaunchProblem}).{' '}
            {starterLaunchReason} Try again once Station says it is safe — this
            picks up the same task rather than making another.
          </p>
        )}

      <div className="project-page__task-grid">
        <div className="project-page__task-list">
          {tasksError ? (
            <ErrorState
              variant="compact"
              title="Unable to load tasks"
              description={describeReadFailure(tasksError)}
              action={
                <Button size="sm" onClick={() => void refetchTasks()}>
                  Retry
                </Button>
              }
            />
          ) : sortedTasks.length === 0 && providerItems.length === 0 ? (
            /* empty-state action: task creation form is adjacent */
            <Empty variant="compact" label="No tasks yet." />
          ) : (
            <>
              {sortedTasks.map((task) => (
                <button
                  className={`project-page__task-row ${
                    task.id === selectedTaskId
                      ? 'project-page__task-row--active'
                      : ''
                  }`}
                  key={task.id}
                  type="button"
                  onClick={() => selectLocalTask(task.id)}
                >
                  <span className="project-page__task-row-title">
                    {task.title}
                  </span>
                  <span className="project-page__task-row-meta">
                    {task.status} · {task.priority}
                  </span>
                </button>
              ))}
              {providerItems.map((item) => (
                <button
                  className={`project-page__task-row ${
                    item.id === selectedProviderItemId
                      ? 'project-page__task-row--active'
                      : ''
                  }`}
                  key={item.id}
                  type="button"
                  onClick={() => selectProviderItem(item.id)}
                >
                  <span className="project-page__task-row-title">
                    {item.title}
                  </span>
                  <span className="project-page__task-row-meta">
                    <span
                      className="project-page__task-row-chip"
                      data-testid="provider-chip"
                    >
                      {item.provider.label}
                    </span>{' '}
                    {item.status}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="project-page__task-detail">
          {selectedProviderItem ? (
            <>
              <div className="project-page__task-detail-header">
                <div>
                  <div className="project-page__task-detail-title">
                    {selectedProviderItem.title}
                  </div>
                  <div className="project-page__task-detail-meta">
                    <span
                      className="project-page__task-row-chip"
                      data-testid="source-chip-detail"
                    >
                      {selectedProviderItem.provider.label}
                    </span>{' '}
                    {selectedProviderItem.status} · read-only
                  </div>
                  {selectedProviderItem.url && (
                    <div className="project-page__task-detail-meta">
                      <a
                        href={selectedProviderItem.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {selectedProviderItem.url}
                      </a>
                    </div>
                  )}
                  {providerItemClaim?.state === 'claimed' &&
                    providerItemClaim.actor && (
                      <div
                        className="project-page__task-detail-meta"
                        data-testid="provider-claim-badge"
                      >
                        Claimed by {actorLabel(providerItemClaim.actor)}
                      </div>
                    )}
                </div>
              </div>
              <div className="project-page__task-empty">
                Linked work item — dispatch is not available for this item yet.
              </div>
            </>
          ) : selectedTask ? (
            <>
              <div className="project-page__task-detail-header">
                <div>
                  <div className="project-page__task-detail-title">
                    {selectedTask.title}
                  </div>
                  <div className="project-page__task-detail-meta">
                    {selectedTask.sessionId
                      ? `Session ${selectedTask.sessionId}`
                      : 'No session yet'}
                  </div>
                  {taskClaim?.state === 'claimed-by-me' && (
                    <div
                      className="project-page__task-detail-meta"
                      data-testid="task-claim-badge"
                    >
                      Claimed by you
                    </div>
                  )}
                  {taskClaim?.state === 'claimed-by-other' &&
                    taskClaim.actor && (
                      <div
                        className="project-page__task-detail-meta"
                        data-testid="task-claim-badge"
                      >
                        Claimed by {actorLabel(taskClaim.actor)}
                      </div>
                    )}
                  {workflowMatch && (
                    <WorkflowStatusLine
                      entry={{
                        taskSlug: workflowMatch.match.taskSlug,
                        status: workflowMatch.match.status,
                        phase: workflowMatch.match.phase,
                        currentStep: workflowMatch.match.flowRun?.current_step,
                        openGateIds: workflowMatch.match.flowRun?.open_gate_ids,
                        matchKind: workflowMatch.kind,
                      }}
                    />
                  )}
                </div>
                <div className="project-page__task-detail-actions">
                  <button
                    className="project-page__add-btn"
                    type="button"
                    onClick={() =>
                      navigate(`/tasks/${encodeURIComponent(selectedTask.id)}`)
                    }
                  >
                    Open Task
                  </button>
                  <button
                    className="project-page__add-btn"
                    type="button"
                    title={
                      taskClaim?.state === 'claimed-by-other' && taskClaim.actor
                        ? `Claimed by ${actorLabel(taskClaim.actor)}`
                        : undefined
                    }
                    disabled={
                      dispatchTaskMutation.isPending ||
                      selectedTask.status === 'done' ||
                      selectedTask.status === 'canceled' ||
                      taskClaim?.state === 'claimed-by-other'
                    }
                    onClick={dispatchSelectedTask}
                  >
                    {taskClaim?.state === 'claimed-by-other'
                      ? 'Claimed by another actor'
                      : 'Dispatch'}
                  </button>
                </div>
              </div>
              <dl className="project-page__task-binding">
                <div>
                  <dt>Working directory</dt>
                  <dd>{binding?.workingDirectory ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Git top-level</dt>
                  <dd>{binding?.repoRoot ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Worktree</dt>
                  <dd>{binding?.worktreePath ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{binding?.branch ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{selectedTask.agentId ?? 'Unavailable'}</dd>
                </div>
              </dl>
              <div className="project-page__relation-timeline">
                {links.length === 0 ? (
                  <div className="project-page__task-empty">
                    No relations recorded.
                  </div>
                ) : (
                  links.map((link) => (
                    <div className="project-page__relation-row" key={link.id}>
                      <span className="project-page__relation-dot" />
                      <span>{relationLabel(link)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            /* empty-state action: task selection list is adjacent */
            <Empty variant="compact" label="Select a task." />
          )}
        </div>
      </div>
    </section>
  );
}
