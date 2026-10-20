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
    ? 'Received. Safe to close the app.'
    : stationOutlivesApp === false
      ? 'Received. Keep the app open.'
      : 'Received';
}
