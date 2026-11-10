import type { ChatStationBindingV1 } from '../connections/station-connection';
import { stationStateKey } from '../connections/station-state';
import type { ChatMessage } from '../contexts/active-chats-state';

export interface RetainedChatTranscript {
  version: 1;
  stationKey: string;
  conversationId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const MAX_ROWS = 40;
const MAX_TEXT_BYTES = 64 * 1024;

/** A closed text copy for an unavailable tab, never input to live state. */
export function retainChatTranscript(
  binding: ChatStationBindingV1,
  conversationId: string,
  messages: readonly ChatMessage[],
): RetainedChatTranscript {
  const rows = messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const parts = message.contentParts?.filter((part) => part.type === 'text');
    return (
      parts?.length
        ? parts.map((part) => part.content ?? '')
        : [message.content]
    )
      .filter(Boolean)
      .map((content) => ({
        role: message.role as 'user' | 'assistant',
        content,
      }));
  });
  const kept: RetainedChatTranscript['messages'] = [];
  let remaining = MAX_TEXT_BYTES;
  for (const row of rows.slice(-MAX_ROWS).reverse()) {
    let content = row.content;
    while (new TextEncoder().encode(content).length > remaining)
      content = content.slice(Math.ceil(content.length / 4));
    if (content) kept.unshift({ ...row, content });
    remaining -= new TextEncoder().encode(content).length;
    if (remaining === 0) break;
  }
  return {
    version: 1,
    stationKey: stationStateKey(binding),
    conversationId,
    messages: kept,
  };
}

export function readRetainedChatTranscript(
  value: unknown,
  binding: ChatStationBindingV1 | undefined,
  conversationId: string | undefined,
): RetainedChatTranscript | undefined {
  if (
    !conversationId ||
    !binding ||
    binding.affinity.kind === 'host' ||
    !value ||
    typeof value !== 'object'
  )
    return;
  const copy = value as Partial<RetainedChatTranscript>;
  if (
    copy.version !== 1 ||
    copy.stationKey !== stationStateKey(binding) ||
    copy.conversationId !== conversationId ||
    !Array.isArray(copy.messages)
  )
    return;
  return retainChatTranscript(
    binding,
    conversationId,
    copy.messages.filter(
      (row) =>
        row &&
        (row.role === 'user' || row.role === 'assistant') &&
        typeof row.content === 'string',
    ),
  );
}
