import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';
import type { SessionLifecycleState } from '@kontourai/station-contracts/session-lifecycle';
import type { WorkStatus } from '../views/home/work-status';

/**
 * #4695: agent-reported plan progress on a Task card or a Session row,
 * projected from the canonical `plan.updated` events in the Session's
 * latest-turn window.
 *
 * Plan progress is what the agent says about its own plan. It is never
 * evidence: nothing here satisfies a gate or changes a Task's status.
 */
export interface TaskPlanProgress {
  /** Steps the agent reported `completed`. */
  done: number;
  total: number;
  /** A step the agent reported `in_progress`, when there is one. */
  active: boolean;
  /**
   * Set while steps remain open but the run cannot advance them on its own:
   * `stopped` after an aborted turn or a failed or canceled Session,
   * `waiting` while the Session is blocked or waits on input or approval.
   */
  halted?: 'stopped' | 'waiting';
  /** The newest plan update predates the Session's latest turn. */
  stale: boolean;
}

const STOPPED_STATES: ReadonlySet<SessionLifecycleState> = new Set([
  'failed',
  'canceled',
]);
const WAITING_STATES: ReadonlySet<SessionLifecycleState> = new Set([
  'blocked',
  'needs_input',
  'review_pending',
]);

/**
 * Returns `null` (render nothing) when there is no countable plan: no
 * `plan.updated`, an empty plan, or entries stored out of line that this
 * bounded read cannot count. A step with a status outside the canonical
 * vocabulary is counted, but never as done.
 */
export function projectTaskPlanProgress(
  events: readonly Pick<OrchestrationSequencedEvent, 'sequence' | 'event'>[],
  lifecycleState?: SessionLifecycleState,
): TaskPlanProgress | null {
  let plan: { sequence: number; turnId?: string; entries: unknown } | null =
    null;
  let latestTurnStart = -Infinity;
  const abortedTurns = new Set<string>();
  for (const { sequence, event } of events) {
    if (event.method === 'turn.started') {
      latestTurnStart = Math.max(latestTurnStart, sequence);
    } else if (event.method === 'turn.aborted') {
      abortedTurns.add(event.turnId);
    } else if (
      event.method === 'plan.updated' &&
      (!plan || sequence >= plan.sequence)
    ) {
      plan = { sequence, turnId: event.turnId, entries: event.entries };
    }
  }
  if (!plan || !Array.isArray(plan.entries) || plan.entries.length === 0)
    return null;

  let done = 0;
  let active = false;
  for (const entry of plan.entries as unknown[]) {
    const status =
      entry && typeof entry === 'object'
        ? (entry as { status?: unknown }).status
        : undefined;
    if (status === 'completed') done += 1;
    else if (status === 'in_progress') active = true;
  }
  const total = plan.entries.length;
  const open = done < total;
  const halted =
    open &&
    ((plan.turnId !== undefined && abortedTurns.has(plan.turnId)) ||
      (lifecycleState !== undefined && STOPPED_STATES.has(lifecycleState)))
      ? 'stopped'
      : open &&
          lifecycleState !== undefined &&
          WAITING_STATES.has(lifecycleState)
        ? 'waiting'
        : undefined;
  return {
    done,
    total,
    active: open && active,
    ...(halted ? { halted } : {}),
    stale: plan.sequence < latestTurnStart,
  };
}

/** The accessible name, e.g. "Agent-reported plan: 3 of 5 steps done". */
export function taskPlanProgressLabel(progress: TaskPlanProgress): string {
  const steps = progress.total === 1 ? 'step' : 'steps';
  const qualifiers = [
    progress.halted === 'stopped' ? 'stopped' : undefined,
    progress.halted === 'waiting' ? 'waiting' : undefined,
    progress.stale ? 'from an earlier turn' : undefined,
  ].filter(Boolean);
  return `Agent-reported plan: ${progress.done} of ${progress.total} ${steps} done${
    qualifiers.length ? `, ${qualifiers.join(', ')}` : ''
  }`;
}

/**
 * How a Session row on Home or in Activity reads its plan, from where the
 * status ladder files the row (the one session-state vocabulary). A Draft
 * never ran, so it is not read. Rows that are running or need someone
 * refresh. Every other row is read once: a Session at rest or ended still
 * shows how far its plan got (and Stopped when it stopped with steps open).
 */
export function sessionPlanProgressRead(
  status: Pick<WorkStatus, 'lane'>,
): 'skip' | 'live' | 'settled' {
  switch (status.lane) {
    case 'drafts':
      return 'skip';
    case 'running':
    case 'needsYou':
      return 'live';
    default:
      return 'settled';
  }
}
