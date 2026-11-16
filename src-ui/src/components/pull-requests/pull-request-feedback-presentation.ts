import {
  describePullRequestFeedbackCategories,
  type PullRequestFeedbackDelivery,
  type PullRequestFeedbackView,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { PullRequestChipValue } from './pull-request-chips';

/** The row's one feedback chip; none while feedback is off or elsewhere. */
export function pullRequestFeedbackChip(
  view: PullRequestFeedbackView | undefined,
): PullRequestChipValue | null {
  if (!view?.ownedHere) return null;
  switch (view.status.state) {
    case 'watching':
      return { label: 'Auto-fix on', tone: 'success' };
    case 'held':
      return { label: 'Held', tone: 'pending' };
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
      return { text: 'Pull request closed; feedback stopped' };
    case 'unavailable':
      return {
        text:
          status.cause === 'credentials'
            ? 'Sign in to GitHub on this Station to get feedback'
            : status.cause === 'unsupported'
              ? 'Feedback is not available for this forge yet'
              : 'Station could not read this pull request',
      };
    case 'paused':
      return {
        text:
          status.reason === 'repeated-failure'
            ? `Paused: the same checks failed on 3 pushes (${short(status.headSha)})`
            : `Paused after 3 rounds on ${short(status.headSha)}`,
      };
    case 'held': {
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
                : 'Watching reviews',
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
