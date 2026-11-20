import {
  type ChildWorkItem,
  type ChildWorkSessionView,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import type { OwnedSessionActivity } from '@kontourai/station-contracts/orchestration';

/**
 * Whether a session whose turn ended is really finished, or still has work
 * that will produce more. Used for the "Your agent finished" alert
 * (`turn-completion-notifications.ts`) and the phone card's Done phase
 * (`agent-activity-card.ts`). Failures, stops, approvals and questions are
 * never held.
 *
 * What holds:
 * - `child-agent`: a running child of kind `agent`, meaning an engine
 *   subagent or a Station delegate reported on this session. Always holds:
 *   its result comes back to this conversation.
 * - `foreground-command`: a running `command` or `monitor` child that is not
 *   `backgrounded`. Child-work has no "the agent is awaiting this" signal.
 *   `backgrounded` ("outlives the turn that spawned it") is the closest fact,
 *   so a backgrounded command or monitor does not hold. A dev server left
 *   running must not block "finished" forever.
 * - `owned-session`: a Station-owned child session still running, or a
 *   cascade stop still pending (`ownedSessionActivities`). Background-boundary
 *   delegations are not counted there, by design of that read.
 * - `engine-work`: the adapter says its engine still runs a task
 *   (`hasOpenEngineWork`), and the child-work record cannot classify it: it
 *   is `not-reported`, absent, or lists nothing running. When the record
 *   lists running children, the per-child rules above decide. Claude counts
 *   every background shell task as open engine work, so treating that flag
 *   alone as a hold would let a dev server block "finished" forever.
 * - `follow-up-pending`: Claude announced it is about to open a turn of its
 *   own after a background child settled (`provider/follow-up-pending`).
 * - `queued-follow-up`: a follow-up waits in the conversation's inbox.
 */
export type FinishedAlertHoldReason =
  | 'child-agent'
  | 'foreground-command'
  | 'owned-session'
  | 'engine-work'
  | 'follow-up-pending'
  | 'queued-follow-up';

export interface FinishedAlertHoldFacts {
  ownedWork?: Pick<
    OwnedSessionActivity,
    'runningChildCount' | 'pendingStopCount'
  >;
  childWork?: ChildWorkSessionView;
  openEngineWork?: boolean;
  followUpPending?: boolean;
  queuedFollowUp?: boolean;
}

/** Whether one running child holds its parent's "finished" alert. */
export function childWorkHoldsFinishedAlert(
  item: Pick<
    ChildWorkItem,
    'status' | 'workKind' | 'kindLabel' | 'backgrounded'
  >,
): boolean {
  if (item.status !== 'running') return false;
  if (childWorkKindOf(item) === 'agent') return true;
  return item.backgrounded !== true;
}

/** Every reason the facts hold the alert, in a fixed order; empty when none. */
export function finishedAlertHoldReasons(
  facts: FinishedAlertHoldFacts,
): FinishedAlertHoldReason[] {
  const reasons: FinishedAlertHoldReason[] = [];
  const running =
    facts.childWork?.observability === 'reported'
      ? facts.childWork.running
      : [];
  if (
    running.some(
      (item) =>
        childWorkKindOf(item) === 'agent' && childWorkHoldsFinishedAlert(item),
    )
  )
    reasons.push('child-agent');
  if (
    running.some(
      (item) =>
        childWorkKindOf(item) !== 'agent' && childWorkHoldsFinishedAlert(item),
    )
  )
    reasons.push('foreground-command');
  if (
    facts.ownedWork &&
    (facts.ownedWork.runningChildCount > 0 ||
      facts.ownedWork.pendingStopCount > 0)
  )
    reasons.push('owned-session');
  if (facts.openEngineWork === true && running.length === 0)
    reasons.push('engine-work');
  if (facts.followUpPending === true) reasons.push('follow-up-pending');
  if (facts.queuedFollowUp === true) reasons.push('queued-follow-up');
  return reasons;
}
