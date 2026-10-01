import {
  MODEL_PROVIDER_CREDENTIALS_REJECTED,
  modelProviderFailureMessage,
} from '../../providers/model-provider-failure.js';
import { outwardTransportError } from '../../utils/outward-error.js';

/**
 * The failed-turn marker `chat-lifecycle.ts` persists as a user-role message
 * when a `/chat` turn ends with no output: `[SYSTEM_EVENT] [CHAT_ERROR] <text>`.
 *
 * Its `<text>` is now always an outward-safe value
 * (`outwardTurnFailureText`), but markers persisted before that change hold
 * the thrown error's own message — a model provider's error body, which can
 * echo secrets. Stored data is not rewritten; instead every reader that
 * SERVES or INDEXES a transcript (the conversation read seam behind
 * /messages, /export, fork and summary; title generation; the knowledge
 * store's conversation records; a Strands fork's replayed history) passes
 * it through {@link scrubChatErrorMarkers}, which keeps a known-safe text and
 * replaces anything else with the outward generic.
 */
export const CHAT_ERROR_MARKER_PREFIX = '[SYSTEM_EVENT] [CHAT_ERROR] ';

/** Station's own abort error (`StreamPipeline`), whose text is a constant. */
export const STREAM_ABORTED_BY_CLIENT = 'Stream aborted by client';

const STATUS_SENTENCE = /\(HTTP (\d{3})\)\.$/;

/**
 * True only for a text exactly equal to one of the values
 * `outwardTurnFailureText` can produce. Identity, not shape: a provider
 * string that merely resembles a status sentence is not one.
 */
export function isOutwardSafeTurnFailureText(text: string): boolean {
  if (
    text === outwardTransportError('sse') ||
    text === STREAM_ABORTED_BY_CLIENT ||
    text === MODEL_PROVIDER_CREDENTIALS_REJECTED
  ) {
    return true;
  }
  const status = STATUS_SENTENCE.exec(text)?.[1];
  if (status === undefined) return false;
  const code = Number(status);
  return (
    code >= 400 && code <= 599 && text === modelProviderFailureMessage(code)
  );
}

/** The marker text with an unsafe failure text replaced by the generic. */
export function scrubChatErrorMarkerText(text: string): string {
  if (!text.startsWith(CHAT_ERROR_MARKER_PREFIX)) return text;
  const failure = text.slice(CHAT_ERROR_MARKER_PREFIX.length);
  return isOutwardSafeTurnFailureText(failure)
    ? text
    : `${CHAT_ERROR_MARKER_PREFIX}${outwardTransportError('sse')}`;
}

function scrubMessage<T>(message: T): T {
  if (!message || typeof message !== 'object') return message;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return message;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  if (typeof record.content === 'string') {
    const content = scrubChatErrorMarkerText(record.content);
    if (content !== record.content) {
      next.content = content;
      changed = true;
    }
  }
  if (Array.isArray(record.parts)) {
    const parts = record.parts.map((part) => {
      if (
        !part ||
        typeof part !== 'object' ||
        (part as { type?: unknown }).type !== 'text' ||
        typeof (part as { text?: unknown }).text !== 'string'
      ) {
        return part;
      }
      const text = (part as { text: string }).text;
      const scrubbed = scrubChatErrorMarkerText(text);
      if (scrubbed === text) return part;
      changed = true;
      return { ...(part as object), text: scrubbed };
    });
    if (changed) next.parts = parts;
  }
  return changed ? (next as T) : message;
}

/**
 * Returns the messages with every persisted failed-turn marker's text made
 * outward-safe. Messages without an unsafe marker are returned as the same
 * objects; stored data is never modified.
 */
export function scrubChatErrorMarkers<T>(messages: T[]): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const scrubbed = scrubMessage(message);
    if (scrubbed !== message) changed = true;
    return scrubbed;
  });
  return changed ? next : messages;
}
