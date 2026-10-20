interface CodingChatContextItem {
  id: string;
  label: string;
  detail: string;
  messageLine: string;
}

export interface CodingChatContextDraft {
  title: string;
  description: string;
  items: CodingChatContextItem[];
  /**
   * `verbatim` places the selected items' text in the composer as written
   * (a prepared prompt). The default frames them as coding context.
   */
  framing?: 'coding-context' | 'verbatim';
}

export function buildCodingChatInitialMessage(
  items: CodingChatContextItem[],
  framing: CodingChatContextDraft['framing'] = 'coding-context',
): string {
  if (items.length === 0) {
    return '';
  }
  if (framing === 'verbatim') {
    return items.map((item) => item.messageLine).join('\n\n');
  }

  return [
    'Coding context for this chat:',
    '',
    ...items.map((item) => item.messageLine),
    '',
    'Use this context when relevant, but ask before assuming stale terminal or diff state.',
  ].join('\n');
}

/**
 * The first message of a chat started from the start composer with context
 * attached (a requested composer draft, or a coding-context handoff).
 *
 * - No typed message: the selected context alone, byte for byte what
 *   `buildCodingChatInitialMessage` produced when an Agent row started the
 *   chat, and like then it is placed in the new chat's composer to review,
 *   not sent.
 * - A typed message (trailing whitespace dropped, indentation kept): the
 *   message first, then a blank line, then that same context text, and it
 *   is sent. The message leads because it is the
 *   request; the context is the material it is about.
 */
export function composeStartMessage(
  prompt: string,
  items: CodingChatContextItem[],
  framing: CodingChatContextDraft['framing'] = 'coding-context',
): string {
  const context = buildCodingChatInitialMessage(items, framing);
  // Only trailing whitespace goes: leading indentation (a quoted block, a
  // code line) is part of what was typed.
  const typed = prompt.trimEnd();
  if (!typed.trim()) return context;
  return context ? `${typed}\n\n${context}` : typed;
}
