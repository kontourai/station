import { SESSION_STATUS_WORDS } from '@kontourai/station-contracts/session-attention';
import { formatDuration } from '../../utils/relativeTime';
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
 *  needs approval, needs answer, waiting on you, queued to send,
 *  blocked, interrupted                          (Needs you)
 *  failed, stopped                               (finished)
 *  elsewhere                                     (Idle)
 *  N sub-agents, no progress, running            (Running)
 *  draft                                         (Drafts)
 *  done                                          (finished)
 *  idle                                          (Idle)
 *
 * THE ONLY SOURCE OF STATUS WORDS. Every list, card, sheet, pane, banner and
 * strip that names a conversation's state renders `word` (or `line`) from
 * here; `session-state-word-consistency.test.ts` fails on a synonym written
 * anywhere else. The words are short on purpose: the row corner already
 * carries the time, so an idle row says "Idle" and nothing about when; a
 * reason (why it failed, why nothing here can answer it) is `reason`, read
 * by the hover card and the Details sheet, never printed on the row.
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
  /** What the word is about (the running tool, a failure's cause). */
  detail?: string;
  /**
   * The longer form behind the word, for the hover card and the Details
   * sheet: why nothing here can answer, why a run was stopped, where an
   * attached transcript was started. Never on the row itself.
   */
  reason?: string;
  /**
   * Epoch ms the line's ticking duration counts from, only while a turn is
   * open: the turn's start, or for a quiet run the instant it went quiet.
   */
  since?: number;
  /** The whole line as text at `now`. */
  line: string;
}

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

type Rung = Omit<WorkStatus, 'line'>;

const ATTENTION_WORDS: Record<WorkAttentionKind, string> = {
  approval: SESSION_STATUS_WORDS.approval,
  answer: SESSION_STATUS_WORDS.answer,
  // The generic rung, for an owed decision whose kind nothing recorded.
  waiting: SESSION_STATUS_WORDS.waiting,
  queued: SESSION_STATUS_WORDS.queued,
  blocked: SESSION_STATUS_WORDS.blocked,
  interrupted: SESSION_STATUS_WORDS.interrupted,
};

/**
 * The ladder's word for one kind of owed decision, for a surface that marks
 * that decision without a whole row to classify: the transcript's approval
 * marker says the pill's "Needs approval" from here, not from a copy.
 */
export function attentionWord(kind: WorkAttentionKind): string {
  return ATTENTION_WORDS[kind];
}

function rungFor(item: HomeWorkItem, facts: WorkFacts | undefined): Rung {
  if (item.controlMode === 'read-only-attached') {
    // The row's meta line already names the app; the word says only that
    // this Station cannot answer in it.
    return {
      rung: 'external',
      lane: 'external',
      tone: 'neutral',
      word: SESSION_STATUS_WORDS.elsewhere,
      reason: `Started in ${item.agentLabel}`,
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
      // The one reason that stays on the row: why it broke is what the user
      // needs before anything else.
      return {
        rung: 'failed',
        lane: 'finished',
        tone: 'broken',
        word: SESSION_STATUS_WORDS.failed,
        detail: item.failureNotice,
      };
    case 'Stopped':
      return {
        rung: 'stopped',
        lane: 'finished',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.stopped,
        reason: item.failureNotice,
      };
    case 'Unanswerable':
      return {
        rung: 'unanswerable',
        lane: 'idle',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.elsewhere,
        reason: item.unanswerableNotice,
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
          word: `${children} sub-agent${children === 1 ? '' : 's'}`,
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
      //
      // The duration is how long it has been quiet, not how long the turn
      // has run: it is the line's one ticking number ("No progress · 4m",
      // "No progress · Bash · 4m"), the same `since` slot a running row
      // ticks in, so every surface counts it off the one shared clock
      // instead of baking a minute count into the word at its own `now`.
      if (silentSince !== undefined) {
        return {
          rung: 'quiet',
          lane: 'running',
          tone: 'caution',
          word: 'No progress',
          detail: activity?.toolName,
          since: silentSince,
        };
      }
      return {
        rung: 'running',
        lane: 'running',
        tone: 'active',
        word: SESSION_STATUS_WORDS.running,
        detail: activity?.toolName,
        since,
      };
    }
    case 'Draft':
      return {
        rung: 'draft',
        lane: 'drafts',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.draft,
      };
    case 'Completed':
      return {
        rung: 'done',
        lane: 'finished',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.done,
      };
    default:
      return {
        rung: 'idle',
        lane: 'idle',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.idle,
      };
  }
}

/**
 * `facts` are the item's `WorkFacts`, derived beside it; without them the
 * line says only what the lifecycle label says, and the lane is the same.
 */
export function workStatus(
  item: HomeWorkItem,
  now: number,
  facts?: WorkFacts,
): WorkStatus {
  const rung = rungFor(item, facts);
  const line = [
    rung.word,
    rung.detail,
    rung.since !== undefined ? formatDuration(now - rung.since) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return { ...rung, line };
}

/**
 * The line without its duration: the word and what it is about. For text
 * that does not tick (a tooltip, a title): a duration frozen at a list's
 * coarse `now` would disagree with the ticking number beside it.
 */
export function workStatusText(status: Pick<WorkStatus, 'word' | 'detail'>) {
  return [status.word, status.detail].filter(Boolean).join(' · ');
}
