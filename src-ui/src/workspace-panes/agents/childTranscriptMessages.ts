import type { ChildWorkTranscriptEntry } from '@kontourai/station-contracts/child-work';
import type { ChatMessage } from '../../types';

type ContentPart = NonNullable<ChatMessage['contentParts']>[number];

const TEXT_CUT = '\n\n[Text truncated by the engine transcript reader]';

/**
 * The text Claude Code writes as a user message when the person stops the
 * agent mid-turn (`[Request interrupted by user]`, `… for tool use]`). It is
 * the engine's record of a stop, not a prompt.
 */
const CLAUDE_INTERRUPT_NOTICE = /^\[Request interrupted by user[^\]]*\]$/;

/** Bounded JSON arguments use the same structured input as live chat rows. */
function transcriptToolInput(input: string | undefined): unknown {
  if (input === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed !== null && typeof parsed === 'object' ? parsed : input;
  } catch {
    return input;
  }
}

/**
 * The child's transcript as chat rows. An engine writes one transcript
 * message per tool call and per tool result, so each run of the agent's work
 * between two prompts becomes one assistant row, the way a live turn is one
 * row: its calls then group into the same tool batch the main chat shows.
 *
 * Only a prompt starts a new row. User-role text that is part of the run
 * stays in it as a muted notice: an interrupt notice, or text the engine
 * wrote in the same message as a tool result (hook feedback). So do the
 * reader's own notes (blocks omitted, a record too large). A result whose
 * call is not on hand is drawn as a tool row, never as the agent's prose.
 * Only engine-issued call identities join a result to its call.
 */
export function childTranscriptMessages(
  entries: readonly ChildWorkTranscriptEntry[],
): ChatMessage[] {
  const results = new Map(
    entries.flatMap((entry) =>
      entry.kind === 'tool-result' && entry.toolCallId
        ? [[entry.toolCallId, entry] as const]
        : [],
    ),
  );
  const calls = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'tool-call' && entry.toolCallId ? [entry.toolCallId] : [],
    ),
  );
  // Transcript messages that carry a tool result: user text beside one is
  // the engine's, not a prompt.
  const resultMessages = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'tool-result' ? [entry.message] : [],
    ),
  );
  const messages: ChatMessage[] = [];
  let turn: { id: string; parts: ContentPart[] } | null = null;
  const closeTurn = () => {
    if (!turn) return;
    messages.push({
      id: turn.id,
      role: 'assistant',
      // What Copy copies: the agent's own words, not notices or tool rows.
      content: turn.parts
        .flatMap((part) => (part.type === 'text' ? [part.content ?? ''] : []))
        .join('\n\n'),
      contentParts: turn.parts,
    });
    turn = null;
  };
  const turnParts = (id: string) => {
    turn ??= { id, parts: [] };
    return turn.parts;
  };
  entries.forEach((entry, index) => {
    const id = `child:${entry.message}:${index}`;
    const cut = entry.truncated ? TEXT_CUT : '';
    switch (entry.kind) {
      case 'text': {
        if (entry.role === 'assistant') {
          turnParts(id).push({ type: 'text', content: entry.text + cut });
          return;
        }
        if (
          resultMessages.has(entry.message) ||
          CLAUDE_INTERRUPT_NOTICE.test(entry.text.trim())
        ) {
          turnParts(id).push({ type: 'notice', content: entry.text + cut });
          return;
        }
        closeTurn();
        messages.push({ id, role: 'user', content: entry.text + cut });
        return;
      }
      case 'tool-call': {
        const result = entry.toolCallId
          ? results.get(entry.toolCallId)
          : undefined;
        turnParts(id).push(
          {
            type: 'tool-invocation',
            toolCallId: entry.toolCallId ?? id,
            toolName: entry.name,
            input: transcriptToolInput(entry.input),
            state: result
              ? result.isError
                ? 'output-error'
                : 'output-available'
              : 'input-available',
            ...(result
              ? {
                  output:
                    (result.text || 'Text output unavailable.') +
                    (result.truncated ? TEXT_CUT : ''),
                  isError: result.isError === true,
                  ...(result.isError
                    ? { errorText: result.text ?? 'Tool failed' }
                    : {}),
                }
              : {}),
          },
          ...(entry.truncated
            ? [
                {
                  type: 'notice',
                  content: 'Tool input truncated by the transcript reader.',
                },
              ]
            : []),
        );
        return;
      }
      case 'tool-result':
        // A keyed result is drawn on its call's row.
        if (entry.toolCallId && calls.has(entry.toolCallId)) return;
        turnParts(id).push({
          type: 'tool-invocation',
          toolCallId: entry.toolCallId ?? id,
          // The call is not on hand (unkeyed, or on an unread page).
          toolName: 'Tool result',
          state: entry.isError ? 'output-error' : 'output-available',
          output: (entry.text || 'Text output unavailable.') + cut,
          isError: entry.isError === true,
          ...(entry.isError ? { errorText: entry.text ?? 'Tool failed' } : {}),
        });
        return;
      case 'omitted':
        turnParts(id).push({
          type: 'notice',
          content: `${entry.count} blocks were omitted from this transcript message.`,
        });
        return;
      case 'too-large':
        turnParts(id).push({
          type: 'notice',
          content: 'An entry too large to show was left out.',
        });
        return;
    }
  });
  closeTurn();
  return messages;
}
