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
 * An inbox row's flag for a conversation holding a message of this device's
 * whose delivery nothing can confirm (#5398). A flag beside the status, never
 * a status of its own.
 */
export const LAST_REPLY_UNCONFIRMED_LABEL = 'Last reply may not have arrived';

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
