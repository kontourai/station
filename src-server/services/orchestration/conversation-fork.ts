import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import {
  boundTranscriptSeedLabel,
  buildTranscriptSeed,
  transcriptSeedSource,
} from './conversation-transcript-seed.js';

export const FORK_REPLAY_DISCLOSURE =
  'Station replay carries the selected transcript only. Engine cursor, tool state, and approval state do not carry.';

/**
 * A branch point names a completed assistant turn. Legacy file transcripts do
 * not always carry a turnId; in that case the last completed assistant row is
 * the only honest default. A user row is never a branch point because its
 * answer may still be in flight.
 */
export function selectForkTranscriptSlice(
  messages: ConversationMessage[],
  branchPointTurnId?: string,
  options: { requirePositiveTerminalEvidence?: boolean } = {},
): {
  messages: ConversationMessage[];
  branchPointTurnId?: string;
  sourceSessionId?: string;
} | null {
  const completed = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.role === 'assistant' &&
        (options.requirePositiveTerminalEvidence
          ? message.metadata?.answerEligible === true
          : message.metadata?.answerEligible !== false),
    );
  const selected = branchPointTurnId
    ? [...completed]
        .reverse()
        .find(
          ({ message }) =>
            message.metadata?.turnId === branchPointTurnId ||
            message.id === branchPointTurnId,
        )
    : completed.at(-1);
  if (!selected) return null;
  return {
    messages: messages.slice(0, selected.index + 1),
    branchPointTurnId: selected.message.metadata?.turnId ?? selected.message.id,
    sourceSessionId: selected.message.metadata?.sessionId,
  };
}

/**
 * Provider-neutral v1 continuation payload.  This is deliberately rendered
 * text, rather than adapter-native history: every Station engine accepts a
 * first user turn, whereas external engines do not share a history API. The
 * shared seed builder carries whole messages under its budget and discloses
 * what it left out (#3164).
 */
export function renderForkTranscript(input: {
  sourceTitle: string;
  sourceAgent: string;
  messages: ConversationMessage[];
}): string {
  return buildTranscriptSeed({
    // Titles and Agent slugs are caller-supplied and unbounded; bound them so
    // the heading can never exceed the seed budget.
    heading: `Continued from a previous conversation (${boundTranscriptSeedLabel(input.sourceTitle)}, on ${boundTranscriptSeedLabel(input.sourceAgent)}); the transcript is context only, not a new request.`,
    ...transcriptSeedSource(input.messages),
  }).text;
}
