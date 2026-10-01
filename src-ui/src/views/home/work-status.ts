import { relativeTime, relativeTimeAgo } from '../../utils/relativeTime';
import type { HomeWorkItem } from './home-view-model';
import type { WorkAttentionKind, WorkFacts } from './work-facts';

/**
 * THE STATUS LADDER (#3042): one function decides a work item's single
 * status line AND the lane it sits in, so a row, its lane heading and the
 * counts over that lane cannot disagree. `partitionHomeWorkItems` reads the
 * lane from here; the shared inbox row reads the line.
 *
 * Pure and `now`-injected. Two inputs, with different jobs:
 *
 * - THE ITEM decides the rung's family and therefore the lane. That is a
 *   switch on `lifecycleLabel` (plus `controlMode`), and nothing else: the
 *   label is already the product's one answer to "what state is this in".
 *   In particular "an owed decision outranks running" is decided where the
 *   label is: the shared attention fold (`sessionAttentionDisposition`)
 *   files an awaiting session ahead of an active one even while its turn is
 *   still open, and a chat's pending approval is read before its running
 *   state. This function does not re-decide it.
 * - THE FACTS (`WorkFacts`, derived beside the item) only choose the words
 *   inside that family: which thing is owed, which tool is running. They
 *   are optional, and the lane is the same with or without them, which is
 *   why the partition can call this with the item alone.
 *
 * Rungs, in the order a reader should expect them down an inbox:
 *
 *  needs approval, needs your answer, waiting on you, queued to send,
 *  blocked, interrupted                          (Needs you)
 *  failed, stopped                               (finished)
 *  can't answer here                             (Idle)
 *  sub-agents running, no progress, running      (Running)
 *  draft                                         (Drafts)
 *  done                                          (finished)
 *  idle                                          (Idle)
 *
 * NOT ON THE LADDER, because nothing computes it: "a sub-agent needs
 * approval". Child work reports only running/settled per child
 * (`ChildWorkItem.status`); a parent's summary carries no request state for
 * its children. A delegated child that needs approval is its own session and
 * reaches the approval rung through its own row.
 */

export type LiveLaneId = 'needsYou' | 'running' | 'idle';

/** Where the ladder files an item. `finished` covers both finished lanes;
 *  which of the two is the partition's acknowledgement/linger question. */
export type WorkLane = LiveLaneId | 'finished' | 'drafts' | 'external';

export type WorkStatusRung =
  | 'external'
  | WorkAttentionKind
  | 'failed'
  | 'stopped'
  | 'unanswerable'
  | 'childWork'
  | 'quiet'
  | 'running'
  | 'draft'
  | 'done'
  | 'idle';

/**
 * The colour discipline for Home/inbox surfaces (archive#1099): colour is
 * reserved for exactly three meanings — act-now, in-motion and broken.
 * Every other state is `neutral`, an unlabelled resting state and not a
 * fourth colour meaning. `caution` is the act-now hue without its urgency:
 * something worth a look that is not owed to the user, so it never pulses.
 */
export type WorkStatusTone =
  | 'attention'
  | 'caution'
  | 'active'
  | 'broken'
  | 'neutral';

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

export interface WorkStatusContext {
  /** The facts derived beside the item; absent says only what the label says. */
  facts?: WorkFacts;
  /** This conversation is on screen right now, so it is not unread. */
  current?: boolean;
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

function rungFor(
  item: HomeWorkItem,
  facts: WorkFacts | undefined,
  now: number,
): Rung {
  if (item.controlMode === 'read-only-attached') {
    return {
      rung: 'external',
      lane: 'external',
      tone: 'neutral',
      word: `Started in ${item.agentLabel}`,
    };
  }
  switch (item.lifecycleLabel) {
    case 'Needs attention': {
      // With no recorded kind (no facts, a durable Task, an older server)
      // something is still owed; it reads as the generic rung.
      const kind = facts?.attention ?? 'waiting';
      return {
        rung: kind,
        lane: 'needsYou',
        tone: 'attention',
        word: ATTENTION_WORDS[kind],
      };
    }
    case 'Failed':
    case 'Stopped':
      return {
        rung: item.lifecycleLabel === 'Failed' ? 'failed' : 'stopped',
        lane: 'finished',
        tone: item.lifecycleLabel === 'Failed' ? 'broken' : 'neutral',
        word: item.lifecycleLabel,
        detail: item.failureNotice,
      };
    case 'Unanswerable':
      return {
        rung: 'unanswerable',
        lane: 'idle',
        tone: 'neutral',
        word: "Can't answer here",
        detail: item.unanswerableNotice,
      };
    case 'Running': {
      const activity = facts?.activity;
      const since = epochMs(activity?.turnStartedAt);
      const children = activity?.childWorkCount ?? 0;
      if (children > 0) {
        return {
          rung: 'childWork',
          lane: 'running',
          tone: 'active',
          word: `${children} sub-agent${children === 1 ? '' : 's'} running`,
          since,
        };
      }
      // The watchdog's own silence marker, never a comparison of
      // `updatedAt` with the clock (see `HomeWorkItem.turnProgress`).
      //
      // Its own rung, in the caution tone, so a silent run is never drawn
      // like a healthy one. The word is the observation itself, not
      // "Stalled": the contract says a quiet run can be expected (a long
      // tool call), so a verdict would claim more than the watchdog
      // computed. The turn is still open and nothing is owed to the user,
      // so the lane stays Running; the tool still running is kept as the
      // detail because it is usually why.
      const silentSince = epochMs(
        item.turnProgress?.progressSilence?.silentSinceEventAt,
      );
      if (silentSince !== undefined) {
        return {
          rung: 'quiet',
          lane: 'running',
          tone: 'caution',
          word: `No progress for ${relativeTime(silentSince, now)}`,
          detail: activity?.toolName,
          since,
        };
      }
      return {
        rung: 'running',
        lane: 'running',
        tone: 'active',
        word:
          item.activeReason === 'background'
            ? 'Background work running'
            : 'Running',
        detail: activity?.toolName,
        since,
      };
    }
    case 'Draft':
      return {
        rung: 'draft',
        lane: 'drafts',
        tone: 'neutral',
        word: 'Draft',
        detail: 'nothing sent yet',
      };
    case 'Completed':
      return { rung: 'done', lane: 'finished', tone: 'neutral', word: 'Done' };
    default:
      return { rung: 'idle', lane: 'idle', tone: 'neutral', word: 'Idle' };
  }
}

export function workStatus(
  item: HomeWorkItem,
  now: number,
  { facts, current = false }: WorkStatusContext = {},
): WorkStatus {
  const rung = rungFor(item, facts, now);
  const unread = !current && changedSinceAcknowledged(item);
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
