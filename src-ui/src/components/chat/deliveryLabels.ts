import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';

/**
 * Delivery wording shared by a message's bubble, the outbox list and the
 * composer status pill, so one state reads the same wherever it is shown.
 */

/** A send that got no answer: Station's delivery lookup decides it. */
export const AWAITING_CONFIRMATION_LABEL =
  'No answer yet. Resends only if it never arrived.';

/** It may have reached the agent; nothing proves which way. */
export const MAY_HAVE_REACHED_LABEL = 'May have reached the agent';

/**
 * Station has the message and the agent has not started on it. Says closing
 * the app is safe only when that Station keeps running without the app
 * (`useStationOutlivesApp`); `undefined` promises nothing either way.
 */
export function receivedDeliveryLabel(
  stationOutlivesApp: boolean | undefined,
): string {
  return stationOutlivesApp === true
    ? 'Received. You can close the app.'
    : stationOutlivesApp === false
      ? 'Received. Keep the app open.'
      : 'Received';
}

/**
 * An inbox row's flag for a conversation holding a message the person sent
 * from this device whose delivery nothing can confirm (#5398). A flag beside
 * the status, never a status of its own. It is the person's message that is
 * in doubt, not the agent's reply.
 */
export const LAST_MESSAGE_UNCONFIRMED_LABEL =
  'Last message may not have arrived';

/**
 * What one Check found, for the message's note and the inbox row's flag
 * alike. `null` reports nothing for an answer no sentence covers.
 */
export function deliveryCheckResult(
  outcome: TurnDeliveryOutcome | undefined,
): string | null {
  if (outcome === undefined) return 'Nothing new to check right now.';
  if (outcome === 'not-received')
    return 'Station did not receive it. Retry sends it with the same message key.';
  if (outcome === 'received' || outcome === 'queued')
    return 'Station has the message. The agent has not started it yet.';
  if (outcome === 'started') return 'The agent started this message.';
  return outcome === 'indeterminate' ||
    outcome === 'expired' ||
    outcome === 'unknown'
    ? 'Station still can’t confirm it.'
    : null;
}

/** One Check answer's weight for the inbox row: most serious first. */
const CHECK_ANSWER_ORDER = [
  'not-received',
  'cannot-confirm',
  'received',
  'started',
] as const;
type CheckAnswer = (typeof CHECK_ANSWER_ORDER)[number];

/** `undefined` is no answer (nothing to check): it is left out. */
function checkAnswer(
  outcome: TurnDeliveryOutcome | undefined,
): CheckAnswer | undefined {
  if (outcome === undefined) return undefined;
  if (outcome === 'not-received' || outcome === 'started') return outcome;
  if (outcome === 'received' || outcome === 'queued') return 'received';
  return 'cannot-confirm';
}

function oneOrMany(count: number) {
  return count === 1 ? 'it' : 'them';
}

/** The answer, then where to act on it: one sentence each. */
function answerSentences(
  worst: CheckAnswer,
  count: number,
  total: number,
): { answer: string; action?: string } {
  const some = `${count === total ? total : `${count} of ${total}`} ${
    total === 1 ? 'message' : 'messages'
  }`;
  const them = oneOrMany(count);
  switch (worst) {
    case 'not-received':
      return {
        answer: `Station did not receive ${some}.`,
        action: `Open the chat to send ${them} again`,
      };
    case 'cannot-confirm':
      return {
        answer: `Station still can’t confirm ${some}.`,
        action: `Open the chat to discard ${them}`,
      };
    case 'received':
      return {
        answer: `Station has ${some}; the agent has not started ${them}.`,
      };
    default:
      return { answer: `The agent started ${some}.` };
  }
}

/**
 * What one inbox-row Check found across the messages it asked about (#5398),
 * oldest first. A single answer reads as the message note's sentence.
 * Several name the most serious answer first, with its count, and where to
 * act, so a message Station never received is never hidden behind another
 * one's good news. `remaining` counts the messages left unchecked; the line
 * stays at two sentences.
 */
export function inboxCheckResult(
  outcomes: readonly (TurnDeliveryOutcome | undefined)[],
  remaining = 0,
): string | null {
  const answered = outcomes.filter((outcome) => outcome !== undefined);
  const answers = answered.map(checkAnswer);
  const more = remaining > 0 ? ` and check ${remaining} more` : '';
  const checkMore = `Open the chat to check ${remaining} more.`;
  if (answered.length === 0) {
    const nothing = deliveryCheckResult(undefined);
    return remaining > 0 ? `${nothing} ${checkMore}` : nothing;
  }
  const worst =
    CHECK_ANSWER_ORDER.find((answer) => answers.includes(answer)) ??
    'cannot-confirm';
  if (answered.length === 1 && remaining === 0) {
    const sentence = deliveryCheckResult(answered[0]);
    return worst === 'cannot-confirm'
      ? `${sentence} Open the chat to discard it.`
      : sentence;
  }
  const count = answers.filter((answer) => answer === worst).length;
  const { answer, action } = answerSentences(worst, count, answered.length);
  if (action) return `${answer} ${action}${more}.`;
  return remaining > 0 ? `${answer} ${checkMore}` : answer;
}
