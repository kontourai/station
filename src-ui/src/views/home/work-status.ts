import { relativeTime, relativeTimeAgo } from '../../utils/relativeTime';
import type { HomeWorkItem, WorkAttentionKind } from './home-view-model';

/**
 * THE STATUS LADDER (#3042): one function decides a work item's single
 * status line AND the lane it sits in, so a row, its lane heading and the
 * counts over that lane cannot disagree. `partitionHomeWorkItems` reads the
 * lane from here; the shared inbox row reads the line.
 *
 * Pure and `now`-injected. Every rung reads a fact the item already carries
 * (see `HomeWorkItem`), and the facts are independent of each other: an
 * awaiting session whose turn is still open carries BOTH `attention` and
 * `activity`. The ORDER below is therefore the contract, not a restatement
 * of `lifecycleLabel`:
 *
 *  1. needs approval            (Needs you)
 *  2. needs your answer         (Needs you)
 *  3. waiting on you / queued   (Needs you)
 *  4. blocked                   (Needs you)
 *  5. interrupted               (Needs you)
 *  6. failed, stopped           (finished)
 *  7. can't answer here         (Idle)
 *  8. sub-agents running        (Running)
 *  9. running                   (Running)
 * 10. draft                     (Drafts)
 * 11. done                      (finished)
 * 12. idle                      (Idle)
 *
 * An owed decision always outranks running: rungs 1-5 are tested before any
 * `activity` is read.
 *
 * NOT ON THE LADDER, because nothing computes it: "a sub-agent needs
 * approval". Child work reports only running/settled per child
 * (`ChildWorkItem.status`); a parent's summary carries no request state for
 * its children. A delegated child that needs approval is its own session and
 * reaches rung 1 through its own row.
 */

export type LiveLaneId = 'needsYou' | 'running' | 'idle';

/** Where the ladder files an item. `finished` covers both finished lanes;
 *  which of the two is the partition's acknowledgement/linger question. */
export type WorkLane = LiveLaneId | 'finished' | 'drafts' | 'external';

export type WorkStatusRung =
  | 'external'
  | 'approval'
  | 'answer'
  | 'waiting'
  | 'queued'
  | 'blocked'
  | 'interrupted'
  | 'failed'
  | 'stopped'
  | 'unanswerable'
  | 'childWork'
  | 'running'
  | 'draft'
  | 'done'
  | 'idle';

/**
 * The colour discipline for Home/inbox surfaces (archive#1099): colour is
 * reserved for exactly three meanings — act-now, in-motion and broken.
 * Every other state is `neutral`, an unlabelled resting state and not a
 * fourth colour meaning.
 */
export type WorkStatusTone = 'attention' | 'active' | 'broken' | 'neutral';

export interface WorkStatus {
  rung: WorkStatusRung;
  lane: WorkLane;
  tone: WorkStatusTone;
  /** The status word. Always present: status is never colour-only. */
  word: string;
  /** What the word is about (a tool, a recorded reason, a recency). */
  detail?: string;
  /** Epoch ms a ticking duration counts from; only while a turn is open. */
  since?: number;
  /** The conversation changed since the version the user last opened. */
  unread: boolean;
  /** The whole line as text at `now`. */
  line: string;
}

/**
 * Whether the item's conversation has a version the user has not opened.
 * The partition's finished-lane split and the row's unread marker both read
 * this, so "still in Just finished" and "marked unread" are one answer.
 * False for an item with no conversation inventory record: there is nothing
 * to have acknowledged.
 */
export function changedSinceAcknowledged(
  item: Pick<HomeWorkItem, 'conversationUpdatedAt' | 'acknowledgedAt'>,
): boolean {
  if (!item.conversationUpdatedAt) return false;
  return !(
    item.acknowledgedAt !== undefined &&
    item.acknowledgedAt >= Date.parse(item.conversationUpdatedAt)
  );
}

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "42s", "1m 12s", "1h 04m": a duration that reads the same while ticking. */
export function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

type Rung = Omit<WorkStatus, 'unread' | 'line'>;

const ATTENTION_WORDS: Record<WorkAttentionKind, string> = {
  approval: 'Needs approval',
  answer: 'Needs your answer',
  waiting: 'Waiting on you',
  queued: 'Queued to send',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
};

/**
 * Rungs 1-5, most urgent first. An item carries ONE kind; this order decides
 * which survives when a chat and its session each recorded a different one
 * (`mergeHomeWorkItems`).
 */
const WORK_ATTENTION_ORDER: readonly WorkAttentionKind[] = [
  'approval',
  'answer',
  'waiting',
  'queued',
  'blocked',
  'interrupted',
];

export function moreUrgentAttention(
  left: WorkAttentionKind | undefined,
  right: WorkAttentionKind | undefined,
): WorkAttentionKind | undefined {
  if (!left || !right) return left ?? right;
  return WORK_ATTENTION_ORDER.indexOf(right) <
    WORK_ATTENTION_ORDER.indexOf(left)
    ? right
    : left;
}

function rungFor(item: HomeWorkItem, now: number): Rung {
  if (item.controlMode === 'read-only-attached') {
    return {
      rung: 'external',
      lane: 'external',
      tone: 'neutral',
      word: `Started in ${item.agentLabel}`,
    };
  }
  const label = item.lifecycleLabel;
  // Rungs 1-5. `Needs attention` with no recorded kind (a durable Task, an
  // older server) is still owed something; it reads as the generic rung.
  const attention =
    item.attention ?? (label === 'Needs attention' ? 'waiting' : undefined);
  if (attention) {
    return {
      rung: attention,
      lane: 'needsYou',
      tone: 'attention',
      word: ATTENTION_WORDS[attention],
    };
  }
  if (label === 'Failed' || label === 'Stopped') {
    return {
      rung: label === 'Failed' ? 'failed' : 'stopped',
      lane: 'finished',
      tone: label === 'Failed' ? 'broken' : 'neutral',
      word: label,
      detail: item.failureNotice,
    };
  }
  if (label === 'Unanswerable') {
    return {
      rung: 'unanswerable',
      lane: 'idle',
      tone: 'neutral',
      word: "Can't answer here",
      detail: item.unanswerableNotice,
    };
  }
  if (label === 'Running' || item.activity) {
    const since = epochMs(item.activity?.turnStartedAt);
    const children = item.activity?.childWorkCount ?? 0;
    if (children > 0) {
      return {
        rung: 'childWork',
        lane: 'running',
        tone: 'active',
        word: `${children} sub-agent${children === 1 ? '' : 's'} running`,
        since,
      };
    }
    // The watchdog's own silence marker, never a comparison of `updatedAt`
    // with the clock (see `HomeWorkItem.turnProgress`).
    const silentSince = epochMs(
      item.turnProgress?.progressSilence?.silentSinceEventAt,
    );
    return {
      rung: 'running',
      lane: 'running',
      tone: 'active',
      word:
        item.activeReason === 'background'
          ? 'Background work running'
          : 'Running',
      detail:
        silentSince !== undefined
          ? `no progress for ${relativeTime(silentSince, now)}`
          : item.activity?.toolName,
      since,
    };
  }
  if (label === 'Draft') {
    return {
      rung: 'draft',
      lane: 'drafts',
      tone: 'neutral',
      word: 'Draft',
      detail: 'nothing sent yet',
    };
  }
  if (label === 'Completed') {
    return { rung: 'done', lane: 'finished', tone: 'neutral', word: 'Done' };
  }
  return { rung: 'idle', lane: 'idle', tone: 'neutral', word: 'Idle' };
}

export function workStatus(item: HomeWorkItem, now: number): WorkStatus {
  const rung = rungFor(item, now);
  const unread = changedSinceAcknowledged(item);
  let detail = rung.detail;
  if (rung.rung === 'idle' && item.updatedAt > 0) {
    detail = `${unread ? 'new' : 'last'} activity ${relativeTimeAgo(item.updatedAt, now)}`;
  } else if (rung.rung === 'done' && unread) {
    detail = 'not opened yet';
  }
  const line = [
    rung.word,
    detail,
    rung.since !== undefined ? formatElapsed(now - rung.since) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return { ...rung, detail, unread, line };
}
