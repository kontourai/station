import type { ChildWorkTranscriptEntry } from '@kontourai/station-contracts/child-work';
import type { ChatMessage } from '../../types';

/** Join only engine-issued call identities; legacy unkeyed results remain readable. */
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
  return entries.flatMap((entry, index): ChatMessage[] => {
    if (
      entry.kind === 'tool-result' &&
      entry.toolCallId &&
      calls.has(entry.toolCallId)
    )
      return [];
    return [message(entry, index)];
  });
  function message(
    entry: ChildWorkTranscriptEntry,
    index: number,
  ): ChatMessage {
    const id = `child:${entry.message}:${index}`;
    const cut = entry.truncated
      ? '\n\n[Text truncated by the engine transcript reader]'
      : '';
    switch (entry.kind) {
      case 'text':
        return { id, role: entry.role, content: entry.text + cut };
      case 'tool-call': {
        const result = entry.toolCallId
          ? results.get(entry.toolCallId)
          : undefined;
        return {
          id,
          role: 'assistant',
          content: '',
          contentParts: [
            {
              type: 'tool-invocation',
              toolCallId: entry.toolCallId ?? id,
              toolName: entry.name,
              input: entry.input,
              state: result
                ? result.isError
                  ? 'output-error'
                  : 'output-available'
                : 'input-available',
              ...(result
                ? {
                    output:
                      (result.text ?? 'No text output.') +
                      (result.truncated
                        ? '\n\n[Text truncated by the engine transcript reader]'
                        : ''),
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
          ],
        };
      }
      case 'tool-result':
        return {
          id,
          role: 'assistant',
          content: `${entry.isError ? 'Tool error' : 'Tool result'}\n\n${entry.text ?? 'No text output.'}${cut}`,
        };
      case 'omitted':
        return {
          id,
          role: 'system',
          content: `${entry.count} blocks were omitted from this transcript message.`,
        };
      case 'too-large':
        return {
          id,
          role: 'system',
          content: 'An entry too large to show was left out.',
        };
    }
  }
}
