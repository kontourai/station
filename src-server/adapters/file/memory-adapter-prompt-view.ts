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
import type { UIMessage } from 'ai';
import { currentNativeMemoryHistory } from '../../runtime/conversation/authorized-turn-correlation.js';

/** Must match the literal prefix `chat-lifecycle.ts` persists. */
export const CHAT_ERROR_MARKER = '[SYSTEM_EVENT] [CHAT_ERROR]';

function messageTextParts(message: UIMessage): string[] {
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
export function isChatErrorMarkerMessage(message: UIMessage): boolean {
  if ((message as { role?: string }).role !== 'user') {
    return false;
  }
  return messageTextParts(message).some((text) =>
    text.startsWith(CHAT_ERROR_MARKER),
  );
}

/** Filters `[CHAT_ERROR]` marker messages out of a message list. */
export function excludeChatErrorMarkers(messages: UIMessage[]): UIMessage[] {
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
