import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';

export const FORK_TRANSCRIPT_MAX_CHARS = 12_000;
export const FORK_OMITTED_MARKER = '…earlier turns omitted…';
export const FORK_REPLAY_DISCLOSURE =
  'Station replay carries the selected transcript only. Provider cursor, tool state, and approval state do not carry.';

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

function textOf(message: ConversationMessage): string {
  const candidate = message as unknown as {
    content?: unknown;
    parts?: Array<{ text?: unknown }>;
  };
  if (typeof candidate.content === 'string') return candidate.content;
  return (candidate.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Provider-neutral v1 continuation payload.  This is deliberately rendered
 * text, rather than adapter-native history: every Station engine accepts a
 * first user turn, whereas external engines do not share a history API.
 */
export function renderForkTranscript(input: {
  sourceTitle: string;
  sourceAgent: string;
  messages: ConversationMessage[];
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? FORK_TRANSCRIPT_MAX_CHARS;
  const turns = input.messages
    .map((message) =>
      `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${textOf(message)}`.trim(),
    )
    .filter((turn) => turn !== 'User:' && turn !== 'Assistant:');
  let body = turns.join('\n\n');
  let omitted = false;
  if (body.length > maxChars) {
    omitted = true;
    const available = Math.max(0, maxChars - FORK_OMITTED_MARKER.length - 2);
    const tail: string[] = [];
    let size = 0;
    for (const turn of [...turns].reverse()) {
      const nextSize = size + turn.length + (tail.length ? 2 : 0);
      if (nextSize > available) break;
      tail.unshift(turn);
      size = nextSize;
    }
    // A single oversized last turn still needs to preserve its role label;
    // keep its ending rather than silently producing an empty continuation.
    if (tail.length === 0 && turns.length > 0) {
      const last = turns.at(-1)!;
      const separator = last.indexOf(': ');
      const label = separator === -1 ? '' : last.slice(0, separator + 2);
      tail.push(`${label}${last.slice(-(available - label.length))}`);
    }
    body = `${FORK_OMITTED_MARKER}\n\n${tail.join('\n\n')}`;
  }
  const preamble = `Continued from a previous conversation (${input.sourceTitle}, on ${input.sourceAgent}):`;
  return `${preamble}\n\n${body}${omitted ? '' : ''}`.trim();
}
