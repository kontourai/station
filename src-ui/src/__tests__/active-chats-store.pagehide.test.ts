/**
 * @vitest-environment jsdom
 *
 * #2334: a reload inside the store's 300 ms save debounce restored the state
 * from before the last change. For an approval pick that is an older,
 * possibly looser pick. The app's store flushes its pending save on the page
 * lifecycle events that precede a reload.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';

const SESSION_ID = 'pagehide-flush-chat';

/** The pick as the next load would read it from sessionStorage. */
function persistedPick() {
  const stored = JSON.parse(
    window.sessionStorage.getItem('activeChats') ?? '[]',
  ) as Array<{ sessionId: string; pendingApprovalMode?: string }>;
  return stored.find((chat) => chat.sessionId === SESSION_ID)
    ?.pendingApprovalMode;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('the app store flushes its pending save before the page goes away', () => {
  afterEach(() => {
    setVisibility('visible');
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.flushPendingSave();
  });

  function pickThenChange() {
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Flush chat',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      conversationId: 'conv-flush',
      pendingApprovalMode: 'never',
    });
    activeChatsStore.flushPendingSave();
    expect(persistedPick()).toBe('never');
    // The user tightens the pick; the write is still debounced.
    activeChatsStore.updateChat(SESSION_ID, { pendingApprovalMode: 'ask' });
    expect(persistedPick()).toBe('never');
  }

  test('pagehide writes the newer pick at once', () => {
    pickThenChange();
    window.dispatchEvent(new Event('pagehide'));
    expect(persistedPick()).toBe('ask');
  });

  test('visibilitychange to hidden writes the newer pick at once', () => {
    pickThenChange();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(persistedPick()).toBe('ask');
  });

  test('visibilitychange back to visible does not write', () => {
    pickThenChange();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(persistedPick()).toBe('never');
  });
});
