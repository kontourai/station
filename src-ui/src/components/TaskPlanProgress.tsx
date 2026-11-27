import { useOrchestrationSessionActivityQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import {
  projectTaskPlanProgress,
  sessionPlanProgressRead,
  type TaskPlanProgress,
  taskPlanProgressLabel,
} from '../utils/taskPlanProgress';
import type { WorkStatus } from '../views/home/work-status';
import './TaskPlanProgress.css';

/**
 * #4695: the agent-reported plan progress of one Session, read from its
 * latest-turn window (the same bounded read child work rows use). A loading,
 * failed or plan-less read yields `null` so the card or row shows nothing
 * rather than a 0% bar; the surface stays fully usable.
 */
function usePlanProgress(
  sessionId: string,
  {
    enabled,
    live,
    apiBase,
  }: { enabled: boolean; live: boolean; apiBase?: string },
): TaskPlanProgress | null {
  const activity = useOrchestrationSessionActivityQuery(sessionId, apiBase, {
    enabled: sessionId.length > 0 && enabled,
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

/**
 * The plan progress of a Task's run while it is running: `sessionId` is the
 * run the Task's derivation read (its conversation's current execution),
 * and `running` is its derived lane. Any other Task makes no read at all, so
 * a board of idle and finished Tasks costs no activity reads.
 */
export function useTaskPlanProgress(
  sessionId: string | undefined,
  { running }: { running: boolean },
): TaskPlanProgress | null {
  return usePlanProgress(sessionId?.trim() ?? '', {
    enabled: running,
    live: running,
  });
}

const HALT_TEXT = { stopped: 'Stopped', waiting: 'Waiting' } as const;

/**
 * One fixed-height line: "Agent plan 3/5" and a thin bar. The fraction and
 * any halt word carry the meaning in text; the bar's tone only repeats it.
 */
export function TaskPlanProgressLine({
  progress,
  className,
  announce = 'img',
}: {
  progress: TaskPlanProgress;
  /** A host's placement class; the line's own look stays here. */
  className?: string;
  /**
   * `img` names the line itself. `text` puts the words in screen-reader text
   * instead, for a line that is part of another element's description (an
   * Activity row's subtitle), where a nested image's name may be skipped.
   */
  announce?: 'img' | 'text';
}) {
  const percent = Math.round((progress.done / progress.total) * 100);
  const state =
    progress.done === progress.total
      ? 'complete'
      : (progress.halted ?? (progress.active ? 'active' : 'pending'));
  return (
    <span
      className={
        className ? `task-plan-progress ${className}` : 'task-plan-progress'
      }
      data-state={state}
      data-stale={progress.stale ? 'true' : undefined}
      {...(announce === 'img'
        ? { role: 'img', 'aria-label': taskPlanProgressLabel(progress) }
        : {})}
      title="Reported by the agent. Not evidence; it never completes the work."
    >
      {announce === 'text' && (
        <span className="sr-only">{`, ${taskPlanProgressLabel(progress)}`}</span>
      )}
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
  sessionId,
  running,
}: {
  sessionId: string | undefined;
  running: boolean;
}) {
  const progress = useTaskPlanProgress(sessionId, { running });
  return progress ? <TaskPlanProgressLine progress={progress} /> : null;
}

/**
 * A Session row on Home or in Activity. The row's status-ladder status (the
 * one its status line already shows) decides the read: none for a Draft (no
 * read is mounted), a 5 s refresh while running or needing someone, one read
 * otherwise.
 */
export function SessionPlanProgress({
  status,
  ...props
}: {
  sessionId: string;
  status: Pick<WorkStatus, 'lane'>;
  apiBase?: string;
  className?: string;
  announce?: 'img' | 'text';
}) {
  const read = sessionPlanProgressRead(status);
  return read === 'skip' ? null : (
    <SessionPlanProgressRead {...props} live={read === 'live'} />
  );
}

function SessionPlanProgressRead({
  sessionId,
  live,
  apiBase,
  className,
  announce,
}: {
  sessionId: string;
  live: boolean;
  apiBase?: string;
  className?: string;
  announce?: 'img' | 'text';
}) {
  const progress = usePlanProgress(sessionId.trim(), {
    enabled: true,
    live,
    apiBase,
  });
  return progress ? (
    <TaskPlanProgressLine
      progress={progress}
      className={className}
      announce={announce}
    />
  ) : null;
}
