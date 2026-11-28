import {
  AMBIGUOUS_AGENT_MODEL_CONNECTION_MESSAGE,
  AMBIGUOUS_DEFAULT_MODEL_CONNECTION_MESSAGE,
} from '@kontourai/station-contracts/managed-model-binding';

/*
 * Kept apart from `chatErrorTranslation`, which the entry bundle ships: only
 * the failure notice and the failed-session card read this, both lazy, and a
 * function in an entry module lands in the entry with the contract module it
 * imports (`managed-model-binding`, whose binding classifier the agent editor
 * uses) carried along.
 */

/**
 * The server refuses a turn when more than one model connection is turned on
 * and nothing names which one to use. It says so in one of two sentences: the
 * provider service's (no project or Station default) and the managed-binding
 * refusal an unbound agent's `/chat` answers with. Neither carries a structured
 * code to the UI, only the sentence (wrapped by the station-agent relay as
 * "Station agent did not accept the task turn: …"), so each is recognised by
 * the exact text the server throws, imported from the contract both sides
 * share. The notification surfaces say it in plain words and offer the page
 * that holds the connections; the recorded text stays behind Details.
 *
 * The words do not say "none is the default": an agent bound to one connection
 * reaches the provider service's sentence too, and its owner did choose. The
 * action opens the model connections list, where a connection can be turned
 * off, rather than promising a choice of default.
 */
const AMBIGUOUS_MODEL_CONNECTION_MESSAGES = [
  AMBIGUOUS_DEFAULT_MODEL_CONNECTION_MESSAGE,
  AMBIGUOUS_AGENT_MODEL_CONNECTION_MESSAGE,
];

interface ProviderDefaultFailure {
  summary: string;
  actionLabel: string;
  actionHref: string;
}

export function describeProviderDefaultFailure(
  text: string,
): ProviderDefaultFailure | null {
  return AMBIGUOUS_MODEL_CONNECTION_MESSAGES.some((message) =>
    text.includes(message),
  )
    ? {
        summary:
          'Couldn’t start: more than one model connection is turned on and Station can’t tell which one to use.',
        actionLabel: 'Open model connections',
        actionHref: '/customize/providers',
      }
    : null;
}
