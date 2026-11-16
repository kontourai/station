import type { ChildWorkTranscriptEntry } from '@kontourai/station-contracts/child-work';
import type { ChatMessage } from '../../types';

type ContentPart = NonNullable<ChatMessage['contentParts']>[number];

const TEXT_CUT = '\n\n[Text truncated by the engine transcript reader]';

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
 * message per tool call and per tool result, so each run of assistant work
 * between two user messages becomes one assistant row, the way a live turn
 * is one row: its calls then group into the same tool batch the main chat
 * shows. Only engine-issued call identities join a result to its call;
 * legacy unkeyed results stay readable as text.
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
  const messages: ChatMessage[] = [];
  let turn: { id: string; parts: ContentPart[] } | null = null;
  const closeTurn = () => {
    if (!turn) return;
    messages.push({
      id: turn.id,
      role: 'assistant',
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
      case 'text':
        if (entry.role === 'user') {
          closeTurn();
          messages.push({ id, role: 'user', content: entry.text + cut });
        } else turnParts(id).push({ type: 'text', content: entry.text + cut });
        return;
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
                  type: 'text',
                  content: '[Tool input truncated by transcript reader]',
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
          type: 'text',
          content: `${entry.isError ? 'Tool error' : 'Tool result'}\n\n${entry.text || 'Text output unavailable.'}${cut}`,
        });
        return;
      case 'omitted':
        closeTurn();
        messages.push({
          id,
          role: 'system',
          content: `${entry.count} blocks were omitted from this transcript message.`,
        });
        return;
      case 'too-large':
        closeTurn();
        messages.push({
          id,
          role: 'system',
          content: 'An entry too large to show was left out.',
        });
        return;
    }
  });
  closeTurn();
  return messages;
}
