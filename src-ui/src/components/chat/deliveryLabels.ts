/**
 * Delivery wording shared by a message's bubble and the outbox list, so one
 * state reads the same wherever the message is shown.
 */

/** A send that got no answer: Station's delivery lookup decides it. */
export const AWAITING_CONFIRMATION_LABEL =
  'No answer yet · sends once Station confirms it never arrived';

/** It may have reached the agent; nothing proves which way. */
export const MAY_HAVE_REACHED_LABEL = 'May have reached the agent';
