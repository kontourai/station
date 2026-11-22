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

function checkAnswer(outcome: TurnDeliveryOutcome | undefined): CheckAnswer {
  if (outcome === 'not-received' || outcome === 'started') return outcome;
  if (outcome === 'received' || outcome === 'queued') return 'received';
  return 'cannot-confirm';
}

/** Where to act when the row's Check cannot settle a message itself. */
const OPEN_TO_DISCARD = 'Open the chat to discard it.';

function oneOrMany(count: number) {
  return count === 1 ? 'it' : 'them';
}

/**
 * What one inbox-row Check found across the messages it asked about (#5398),
 * oldest first. One kind of answer reads as the message note's sentence for
 * the newest message. Differing answers name the most serious one, with its
 * count, and where to act, so a message Station never received is never
 * hidden behind another one's good news. `remaining` counts the messages
 * left unchecked.
 */
export function inboxCheckResult(
  outcomes: readonly (TurnDeliveryOutcome | undefined)[],
  remaining = 0,
): string | null {
  const answers = outcomes.map(checkAnswer);
  const worst = CHECK_ANSWER_ORDER.find((answer) => answers.includes(answer));
  if (!worst) return null;
  const count = answers.filter((answer) => answer === worst).length;
  const total = answers.length;
  let sentence: string | null;
  if (count === total) {
    sentence = deliveryCheckResult(outcomes.at(-1));
    if (worst === 'cannot-confirm' && outcomes.at(-1) !== undefined)
      sentence = `${sentence} ${OPEN_TO_DISCARD}`;
  } else if (worst === 'not-received') {
    sentence = `Station did not receive ${count} of ${total} messages. Open the chat to send ${oneOrMany(count)} again.`;
  } else if (worst === 'cannot-confirm') {
    sentence = `Station still can’t confirm ${count} of ${total} messages. Open the chat to discard ${oneOrMany(count)}.`;
  } else {
    sentence = `Station has ${count} of ${total} messages. The agent has not started ${oneOrMany(count)} yet.`;
  }
  return remaining > 0
    ? `${sentence ?? ''} ${remaining} more to check in the chat.`.trim()
    : sentence;
}
