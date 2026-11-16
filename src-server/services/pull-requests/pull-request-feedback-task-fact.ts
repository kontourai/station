/**
 * A pull request's agent feedback as one fact for a Task board card
 * (derived Task lanes): fixing, paused, waiting on checks, sent or watching.
 * Built from what a reader of the owning chat may see, so a reader who may
 * not read it gets nothing. The card shows it only while its `headSha` is
 * the head the provider reported.
 */
import {
  type PullRequestFeedbackByPullRequest,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { TaskPullRequestFeedbackFact } from '@kontourai/station-contracts/task-lane';
import type { PullRequestFeedbackStore } from './pull-request-feedback-store.js';

export function pullRequestFeedbackTaskFact(input: {
  view: PullRequestFeedbackByPullRequest;
  store: Pick<PullRequestFeedbackStore, 'observation' | 'batch'>;
  /**
   * The send key of the owning chat's current turn, when its newest turn
   * has started and not ended.
   */
  openTurnKey(conversationId: string): string | undefined;
  /**
   * The conversation of the Task's own run (its `sessionId`), when it has
   * one: only that run can be fixing for this card.
   */
  taskConversationId?: string;
}): TaskPullRequestFeedbackFact | undefined {
  const { view, store } = input;
  if (!view.owner?.readable || !view.status) return undefined;
  const prKey = pullRequestFeedbackKey(view.identity);
  // Fixing: feedback goes to this Task's own run, and its running turn is
  // the one Station started to send this pull request's failing checks. A
  // turn about review threads alone, another Task's run, or another chat is
  // not this card fixing anything.
  const ownRun =
    input.taskConversationId !== undefined &&
    input.taskConversationId === view.owner.conversationId;
  const turnKey = ownRun
    ? input.openTurnKey(view.owner.conversationId)
    : undefined;
  const batch = turnKey ? store.batch(turnKey) : undefined;
  const carried =
    batch && batch.state !== 'refused' && batch.state !== 'cancelled'
      ? batch.summary.find((entry) => entry.prKey === prKey)
      : undefined;
  if (
    carried?.categories.some(
      (part) => part.category === 'failing-checks' && part.count > 0,
    )
  )
    return { state: 'fixing', headSha: carried.headSha };
  const status = view.status;
  if (status.state === 'paused')
    return { state: 'paused', headSha: status.headSha };
  const head = store.observation(prKey)?.observation.headSha;
  if (!head) return undefined;
  if (status.state === 'held' && status.reason === 'checks-running')
    return { state: 'waiting-on-checks', headSha: head };
  // `last` is already the newest send about the observed head.
  if (view.last?.state === 'sent' && view.last.headSha === head)
    return { state: 'sent', headSha: head, at: view.last.at };
  // Busy or waiting on a person: feedback still goes when it can. A
  // stopped agent or an owner who can no longer send gets no note.
  if (
    status.state === 'watching' ||
    (status.state === 'held' &&
      (status.reason === 'agent-busy' || status.reason === 'agent-waiting'))
  )
    return { state: 'watching', headSha: head };
  return undefined;
}
