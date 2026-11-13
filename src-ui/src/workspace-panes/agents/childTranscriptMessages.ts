import type { ChildWorkTranscriptEntry } from '@kontourai/station-contracts/child-work';
import type { ChatMessage } from '../../types';

/** Provider records carry no call/result join key: preserve their order without inventing a pairing. */
export function childTranscriptMessages(
  entries: readonly ChildWorkTranscriptEntry[],
): ChatMessage[] {
  return entries.map((entry, index) => {
    const id = `child:${entry.message}:${index}`;
    const cut = entry.truncated
      ? '\n\n[Text truncated by the engine transcript reader]'
      : '';
    switch (entry.kind) {
      case 'text':
        return { id, role: entry.role, content: entry.text + cut };
      case 'tool-call':
        return {
          id,
          role: 'assistant',
          content: '',
          contentParts: [
            {
              type: 'tool-invocation',
              toolCallId: id,
              toolName: entry.name,
              input: entry.input,
              state: 'input-available',
            },
          ],
        };
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
  });
}
