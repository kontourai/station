/**
 * archive#191 code-review HIGH-1 fix: excludes the `[CHAT_ERROR]` failed-turn
 * marker from the *prompt-assembly* read path only.
 *
 * `chat-lifecycle.ts`'s `finalizeChatRequest` persists a
 * `[SYSTEM_EVENT] [CHAT_ERROR] <raw message>` marker with `role: 'user'`
 * (reusing the pre-existing `add-system-message` convention documented in
 * `docs/reference/api.md`, which is *deliberately* model-visible and must
 * stay that way for its own callers) so a reload can still show the user
 * what happened. The problem: VoltAgent's `Memory` class
 * (`voltagent-adapter.ts`) is constructed directly on top of the very same
 * `FileMemoryAdapter` instance that `routes/conversations.ts` (the UI
 * history fetch), `chat-lifecycle.ts` (stats counting), monitoring, and
 * every other caller also read from — there is exactly one shared
 * `getMessages` read path, so a message excluded there would vanish from
 * the UI too, and a message left in is fed to the model's own prompt on
 * every subsequent turn, verbatim, as if the user had typed it.
 *
 * `createPromptOnlyMemoryView` is the narrowest fix that doesn't touch
 * either of those: it is handed *only* to `new Memory({ storage })` at the
 * one call site that assembles the model's prompt context. Every other
 * caller keeps using the raw, unwrapped `FileMemoryAdapter` instance (see
 * `runtime-agent-builder.ts`'s `context.memoryAdapters.set(agentSlug,
 * bundle.memoryAdapter)`), so the marker still renders on reload and still
 * counts toward stats. Ordinary `add-system-message` calls (e.g. "User
 * switched to dark mode") are untouched — only the `[CHAT_ERROR]`
 * sub-marker is filtered.
 */
import type { StorageAdapter } from '@voltagent/core';
import { currentNativeMemoryHistory } from '../../runtime/conversation/authorized-turn-correlation.js';

/** Must match the literal prefix `chat-lifecycle.ts` persists. */
const CHAT_ERROR_MARKER = '[SYSTEM_EVENT] [CHAT_ERROR]';

function messageTextParts(message: unknown): string[] {
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text);
}

/** True when a stored message carries the `[CHAT_ERROR]` failed-turn marker. */
function isChatErrorMarkerMessage(message: unknown): boolean {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { role?: unknown }).role !== 'user'
  ) {
    return false;
  }
  // The same shapes the served-transcript scrubber reads: text parts, and a
  // legacy `content` string.
  const content = (message as { content?: unknown }).content;
  return (
    (typeof content === 'string' && content.startsWith(CHAT_ERROR_MARKER)) ||
    messageTextParts(message).some((text) => text.startsWith(CHAT_ERROR_MARKER))
  );
}

/**
 * #3112: an assistant message that carries no reply — no parts, or only
 * step boundaries and blank text/reasoning. VoltAgent opens such a
 * placeholder for every streamed response and flushes it to memory when the
 * stream fails before producing anything.
 */
export function isContentlessAssistantMessage(message: unknown): boolean {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { role?: unknown }).role !== 'assistant'
  )
    return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string' && content.trim()) return false;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return true;
  return parts.every((part) => {
    if (!part || typeof part !== 'object') return true;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type === 'step-start') return true;
    if (type === 'text' || type === 'reasoning')
      return typeof text !== 'string' || text.trim() === '';
    return false;
  });
}

/** Filters `[CHAT_ERROR]` marker messages out of a message list. */
export function excludeChatErrorMarkers<T>(messages: T[]): T[] {
  return messages.filter((message) => !isChatErrorMarkerMessage(message));
}

/**
 * Wraps a `FileMemoryAdapter` so `getMessages` never returns `[CHAT_ERROR]`
 * marker messages; every other `StorageAdapter` method delegates unchanged
 * (bound to the real instance) to the underlying adapter. See the module
 * doc comment above for where this is — and is not — meant to be used.
 */
export function createPromptOnlyMemoryView(
  // Typed to the interface, not to `FileMemoryAdapter`: this view only ever
  // specialises `getMessages` and forwards everything else, so pinning the
  // concrete class bought nothing and blocked any other conversation store
  // (sqlite, sql) from being wired through the same seam (archive#914).
  adapter: StorageAdapter,
  ownerAgentKey?: string,
): StorageAdapter {
  return new Proxy(adapter, {
    get(target, prop, _receiver) {
      // #3112: a failed stream's empty response placeholder is not a reply;
      // the turn's `[CHAT_ERROR]` marker records the failure. A cancelled
      // turn is still written: the store marks it cancelled.
      const keep = (
        message: unknown,
        context?: { abortController?: AbortController },
      ) =>
        !isContentlessAssistantMessage(message) ||
        context?.abortController?.signal.aborted === true;
      if (prop === 'addMessage') {
        return async (...args: Parameters<StorageAdapter['addMessage']>) => {
          if (keep(args[0], args[3] as { abortController?: AbortController }))
            await target.addMessage(...args);
        };
      }
      if (prop === 'addMessages') {
        return async (...args: Parameters<StorageAdapter['addMessages']>) => {
          const kept = args[0].filter((message) =>
            keep(message, args[3] as { abortController?: AbortController }),
          );
          if (kept.length > 0)
            await target.addMessages(kept, args[1], args[2], args[3]);
        };
      }
      if (prop === 'getMessages') {
        return async (...args: Parameters<StorageAdapter['getMessages']>) => {
          const nativeMemory = currentNativeMemoryHistory();
          if (
            nativeMemory &&
            ownerAgentKey &&
            nativeMemory.ownsRuntimeAgentKey(ownerAgentKey) &&
            nativeMemory.currentSessionId === args[1]
          )
            return nativeMemory.read(target, ...args);
          const messages = await target.getMessages(...args);
          return excludeChatErrorMarkers(messages);
        };
      }
      // Bind to `target` (the real adapter), never to the proxy, so
      // internal `this.<field>` access inside the adapter's own methods
      // resolves normally regardless of how the returned function is
      // later invoked.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
