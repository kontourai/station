import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { useOrchestrationSessionActivityQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import {
  projectTaskPlanProgress,
  type TaskPlanProgress,
  taskPlanProgressLabel,
} from '../utils/taskPlanProgress';
import './TaskPlanProgress.css';

/** Tasks whose Session may still be revising its plan. */
const LIVE_TASK_STATUSES: ReadonlySet<TaskRecord['status']> = new Set([
  'in_progress',
  'blocked',
]);
/** Closed Tasks keep their record; their cards skip the per-Session read. */
const CLOSED_TASK_STATUSES: ReadonlySet<TaskRecord['status']> = new Set([
  'done',
  'canceled',
]);

/**
 * #4695: the agent-reported plan progress of a Task's dispatched Session,
 * read from that Session's latest-turn window (the same bounded read child
 * work rows use). A loading, failed or plan-less read yields `null` so the
 * card shows nothing rather than a 0% bar; the card stays fully usable.
 */
export function useTaskPlanProgress(
  task: Pick<TaskRecord, 'sessionId' | 'status'>,
): TaskPlanProgress | null {
  const sessionId = task.sessionId?.trim() ?? '';
  const live = LIVE_TASK_STATUSES.has(task.status);
  const activity = useOrchestrationSessionActivityQuery(sessionId, undefined, {
    enabled: sessionId.length > 0 && !CLOSED_TASK_STATUSES.has(task.status),
    staleTime: live ? 0 : 30_000,
    refetchInterval: live ? 5_000 : undefined,
    retry: false,
    cancelWhenInactive: true,
  });
  return useMemo(
    () =>
      activity.data
        ? projectTaskPlanProgress(
            activity.data.events,
            activity.data.session.lifecycleState,
          )
        : null,
    [activity.data],
  );
}

const HALT_TEXT = { stopped: 'Stopped', waiting: 'Waiting' } as const;

/**
 * One fixed-height line: "Agent plan 3/5" and a thin bar. The fraction and
 * any halt word carry the meaning in text; the bar's tone only repeats it.
 */
export function TaskPlanProgressLine({
  progress,
}: {
  progress: TaskPlanProgress;
}) {
  const percent = Math.round((progress.done / progress.total) * 100);
  const state =
    progress.done === progress.total
      ? 'complete'
      : (progress.halted ?? (progress.active ? 'active' : 'pending'));
  return (
    <span
      className="task-plan-progress"
      data-state={state}
      data-stale={progress.stale ? 'true' : undefined}
      role="img"
      aria-label={taskPlanProgressLabel(progress)}
      title="Reported by the agent. Not evidence; it never completes the Task."
    >
      <span className="task-plan-progress__text" aria-hidden="true">
        Agent plan {progress.done}/{progress.total}
        {progress.halted ? ` · ${HALT_TEXT[progress.halted]}` : ''}
        {progress.stale ? ' · Earlier turn' : ''}
      </span>
      <span className="task-plan-progress__track" aria-hidden="true">
        <span
          className="task-plan-progress__fill"
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

/** For a surface whose accessible name comes from its content (a link). */
export function TaskPlanProgressForTask({
  task,
}: {
  task: Pick<TaskRecord, 'sessionId' | 'status'>;
}) {
  const progress = useTaskPlanProgress(task);
  return progress ? <TaskPlanProgressLine progress={progress} /> : null;
}
