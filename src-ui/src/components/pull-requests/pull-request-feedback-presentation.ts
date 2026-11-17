import {
  describePullRequestFeedbackCategories,
  type PullRequestFeedbackDelivery,
  type PullRequestFeedbackView,
  type PullRequestHeadReview,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { PullRequestChipValue } from './pull-request-chips';

/** The row's one feedback chip; none while feedback is off or elsewhere. */
export function pullRequestFeedbackChip(
  view: PullRequestFeedbackView | undefined,
): PullRequestChipValue | null {
  if (!view?.ownedHere) return null;
  switch (view.status.state) {
    case 'watching':
      return view.settings.fixFailingChecks ||
        view.settings.addressReviewComments
        ? { label: 'Auto-fix on', tone: 'success' }
        : { label: 'Review on', tone: 'success' };
    case 'held':
      return view.status.reason === 'checks-running'
        ? { label: 'Waiting on checks', tone: 'pending' }
        : { label: 'Held', tone: 'pending' };
    case 'paused':
      return { label: 'Paused', tone: 'failure' };
    case 'unavailable':
      return view.status.cause === 'credentials'
        ? { label: 'Needs sign-in', tone: 'failure' }
        : { label: 'Unavailable', tone: 'neutral' };
    default:
      return null;
  }
}

/**
 * The dialog's badge: the same states, as a word and a tone. None while
 * feedback is off or the pull request closed: an "Off" badge read as an
 * empty box, and the switches already say it.
 */
export function pullRequestFeedbackBadge(view: PullRequestFeedbackView):
  | {
      label: string;
      tone: 'positive' | 'caution' | 'negative' | 'neutral';
    }
  | undefined {
  if (!view.ownedHere && view.owner)
    return { label: 'Elsewhere', tone: 'neutral' };
  const chip = pullRequestFeedbackChip(view);
  if (!chip) return undefined;
  return {
    label: chip.label,
    tone:
      chip.tone === 'success'
        ? 'positive'
        : chip.tone === 'pending'
          ? 'caution'
          : chip.tone === 'failure'
            ? 'negative'
            : 'neutral',
  };
}

const short = (sha: string) => sha.slice(0, 7);

/** "Sent 2 failing checks to the agent" — a delivery as one clause. */
export function deliverySentence(
  delivery: PullRequestFeedbackDelivery,
): string {
  const what = describePullRequestFeedbackCategories(delivery.categories);
  switch (delivery.state) {
    case 'sent':
      return `Sent ${what} to the agent`;
    case 'queued':
      return `Sending ${what}`;
    case 'held':
      return `Holding ${what}`;
    case 'refused':
      return `Not sent: ${what}`;
    default:
      return `Replaced: ${what}`;
  }
}

/**
 * The row's one line under the meta: what Station did last, or why it is
 * waiting. `at` is the time to show beside it, when there is one.
 */
export function pullRequestFeedbackLine(
  view: PullRequestFeedbackView | undefined,
): { text: string; at?: string } | null {
  if (!view) return null;
  if (!view.ownedHere)
    return view.owner
      ? {
          text: view.owner.title
            ? `Feedback goes to “${view.owner.title}”`
            : 'Feedback goes to another chat',
        }
      : null;
  const status = view.status;
  switch (status.state) {
    case 'off':
      return null;
    case 'closed':
      return {
        text: 'Pull request closed; Station checks again if it reopens',
      };
    case 'unavailable':
      return {
        text:
          status.cause === 'credentials'
            ? 'Sign in to GitHub on this Station to get feedback'
            : status.cause === 'unsupported'
              ? 'Feedback is not available for this forge yet'
              : status.cause === 'too-large'
                ? 'Feedback is too large to send; open the pull request'
                : 'Station could not read this pull request',
      };
    case 'paused':
      return {
        text:
          status.reason === 'repeated-failure'
            ? `Paused: the same checks failed on 3 pushes (${short(status.headSha)})`
            : status.reason === 'fix-budget'
              ? `Paused: every fix attempt is used (${short(status.headSha)})`
              : status.cap === 'day'
                ? 'Paused after 10 messages in 24 hours'
                : `Paused after 3 rounds on ${short(status.headSha)}`,
      };
    case 'held': {
      if (status.reason === 'checks-running')
        return { text: 'Failing checks wait for the rest to finish' };
      const reason = {
        'agent-busy': 'until the agent finishes',
        'agent-waiting': 'while the agent waits on you',
        'agent-stopped': 'the agent stopped',
        'owner-changed': 'you can no longer send to this chat',
      }[status.reason];
      const held = view.history.find((row) => row.state === 'held');
      return {
        text:
          status.reason === 'agent-busy' || status.reason === 'agent-waiting'
            ? `${held ? deliverySentence(held) : 'Holding feedback'} ${reason}`
            : `Held · ${reason}`,
      };
    }
    default: {
      const last = view.last;
      if (!last)
        return {
          text:
            view.settings.fixFailingChecks &&
            view.settings.addressReviewComments
              ? 'Watching checks and reviews'
              : view.settings.fixFailingChecks
                ? 'Watching checks'
                : view.settings.addressReviewComments
                  ? 'Watching reviews'
                  : 'Reviewing each new head',
        };
      return { text: deliverySentence(last), at: last.at };
    }
  }
}

/** One history row's words: "2 failing checks · a1b2c3d · Sent". */
export function historyRowParts(row: PullRequestFeedbackDelivery): {
  what: string;
  head: string;
  state: string;
} {
  return {
    what: describePullRequestFeedbackCategories(row.categories),
    head: short(row.headSha),
    state: {
      sent: 'Sent',
      queued: 'Queued',
      held: 'Held',
      refused: 'Refused',
      superseded: 'Superseded',
    }[row.state],
  };
}

/** The row's meta facts for Station's newest head review: "Reviewed · 2 findings". */
export function headReviewMeta(
  review: PullRequestHeadReview | undefined,
): string[] {
  // Only about the newest head: an earlier push's review says nothing now.
  if (!review?.current) return [];
  if (review.state === 'reviewing') return ['Reviewing'];
  if (review.state !== 'reviewed') return [];
  const required = review.required ?? 0;
  return required
    ? ['Reviewed', `${required} ${required === 1 ? 'finding' : 'findings'}`]
    : ['Reviewed'];
}
