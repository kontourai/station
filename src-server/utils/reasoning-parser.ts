/**
 * Reasoning parser utility for extracting model reasoning blocks.
 * Converts <thinking> tags (Amazon Nova Pro) into AI SDK ReasoningUIPart format.
 */

import type { UIMessage } from 'ai';

type MessagePart = {
  type: 'text' | 'reasoning';
  text: string;
};

/**
 * Parse reasoning blocks from message text and convert to proper parts array.
 * Extracts <thinking>...</thinking> blocks and creates separate reasoning parts.
 *
 * @param message - UIMessage with potential reasoning in text parts
 * @returns UIMessage with reasoning extracted into separate parts
 */
export function parseReasoningFromMessage(message: UIMessage): UIMessage {
  if (!message.parts || message.parts.length === 0) {
    return message;
  }

  const newParts: MessagePart[] = [];

  for (const part of message.parts) {
    if (part.type !== 'text' || !part.text) {
      // Keep non-text parts as-is
      newParts.push(part as MessagePart);
      continue;
    }

    const extracted = extractReasoningFromText(part.text);
    newParts.push(...extracted);
  }

  return {
    ...message,
    parts: newParts,
  };
}

/**
 * Extract reasoning blocks from text containing <thinking> tags.
 * Returns array of text and reasoning parts in order.
 *
 * @param text - Text potentially containing <thinking>...</thinking> blocks
 * @returns Array of text and reasoning parts
 */
function extractReasoningFromText(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const thinkingStart = remaining.indexOf('<thinking>');

    if (thinkingStart === -1) {
      // No more reasoning blocks, add remaining text if non-empty
      const trimmed = remaining.trim();
      if (trimmed) {
        parts.push({ type: 'text', text: trimmed });
      }
      break;
    }

    // Add text before <thinking> tag
    if (thinkingStart > 0) {
      const beforeText = remaining.slice(0, thinkingStart).trim();
      if (beforeText) {
        parts.push({ type: 'text', text: beforeText });
      }
    }

    // Find closing tag
    const thinkingEnd = remaining.indexOf('</thinking>', thinkingStart);

    if (thinkingEnd === -1) {
      // Unclosed tag - treat rest as text
      const afterTag = remaining
        .slice(thinkingStart + '<thinking>'.length)
        .trim();
      if (afterTag) {
        parts.push({ type: 'text', text: afterTag });
      }
      break;
    }

    // Extract reasoning content
    const reasoningText = remaining
      .slice(thinkingStart + '<thinking>'.length, thinkingEnd)
      .trim();

    if (reasoningText) {
      parts.push({ type: 'reasoning', text: reasoningText });
    }

    // Continue with text after </thinking>
    remaining = remaining.slice(thinkingEnd + '</thinking>'.length);
  }

  return parts;
}
