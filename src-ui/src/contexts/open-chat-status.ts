import { useSyncExternalStore } from 'react';
import type { ChatUIState } from './active-chats-state';
import { activeChatsStore } from './active-chats-store';

type OpenChats = ReturnType<typeof activeChatsStore.getSnapshot>;

/**
 * What a streamed token or a composer keystroke rewrites. Status readers ask
 * only whether a chat is streaming, never what it has said so far.
 */
const STREAMED_OR_TYPED = new Set<keyof ChatUIState>([
  'streamingMessage',
  'planArtifact',
  'activityHint',
  'isProcessingStep',
  'input',
  'inputHistory',
  'historyIndex',
  'savedInput',
]);

function sameChatStatus(a: ChatUIState, b: ChatUIState): boolean {
  if (a === b) return true;
  if (Boolean(a.streamingMessage) !== Boolean(b.streamingMessage)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys as Set<keyof ChatUIState>) {
    if (STREAMED_OR_TYPED.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

let statusRaw: OpenChats | null = null;
let statusValue: OpenChats | null = null;

/**
 * The open-chat map as its status readers see it: the same reference until
 * a chat is added, removed, reordered, starts or stops streaming, or changes
 * any field other than streamed text and the composer draft.
 *
 * Streaming writes the store once per token, so the dock inbox, Home's work
 * rows and their status facts, all subscribed to the raw map, rebuilt every
 * open chat's row and re-rendered their hosts 20 to 50 times a second while
 * a reply streamed. The rows read only streaming presence, so the rebuild
 * produced the same rows each time.
 */
export function openChatStatusSnapshot(): OpenChats {
  const raw = activeChatsStore.getSnapshot();
  if (raw === statusRaw && statusValue) return statusValue;
  statusRaw = raw;
  const previous = statusValue;
  if (previous) {
    const keys = Object.keys(raw);
    const priorKeys = Object.keys(previous);
    if (
      keys.length === priorKeys.length &&
      keys.every(
        (key, index) =>
          key === priorKeys[index] && sameChatStatus(previous[key]!, raw[key]!),
      )
    )
      return previous;
  }
  statusValue = raw;
  return raw;
}

/** Re-renders when a chat's status changes, not per streamed token. */
export function useOpenChatStatus(): OpenChats {
  return useSyncExternalStore(
    activeChatsStore.subscribe,
    openChatStatusSnapshot,
    openChatStatusSnapshot,
  );
}
