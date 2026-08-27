/**
 * @vitest-environment jsdom
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ActiveChatsProvider,
  useActiveChatSelector,
} from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';

const SESSION_ID = 'selector-session';

function clearChats() {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
}

describe('useActiveChatSelector', () => {
  beforeEach(() => {
    clearChats();
    // Deliberately no conversationId — keeps usePruneActiveChats (which
    // ActiveChatsProvider mounts) a no-op so this test doesn't need to mock
    // the conversations SDK.
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Agent One Chat',
    });
  });

  afterEach(() => {
    // Unmount any still-subscribed hook (via RTL's own act-wrapped cleanup)
    // before mutating the store — otherwise removeChat()'s notify() reaches
    // a mounted useSyncExternalStore subscriber outside of act().
    cleanup();
    clearChats();
  });

  test('re-renders and updates when the selected field changes', () => {
    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useActiveChatSelector(SESSION_ID, (state) => state?.input ?? '');
      },
      { wrapper: ActiveChatsProvider },
    );

    expect(result.current).toBe('');
    const renderCountAfterMount = renderCount;

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'hello' });
    });

    expect(result.current).toBe('hello');
    expect(renderCount).toBeGreaterThan(renderCountAfterMount);
  });

  test('does not re-render when an unselected field changes', () => {
    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useActiveChatSelector(
          SESSION_ID,
          (state) => state?.model ?? null,
        );
      },
      { wrapper: ActiveChatsProvider },
    );

    const renderCountAfterMount = renderCount;
    const valueAfterMount = result.current;

    act(() => {
      // active-chats-store.updateChat() replaces the whole session object on
      // every call — this asserts a selector still sees "no change" for a
      // field it didn't select, which is the mechanism that stops composer
      // keystrokes from re-rendering transcript consumers (station#726).
      activeChatsStore.updateChat(SESSION_ID, { input: 'unrelated keystroke' });
    });

    expect(result.current).toBe(valueAfterMount);
    expect(renderCount).toBe(renderCountAfterMount);
  });

  test('a custom isEqual can treat structurally-equal selections as unchanged', () => {
    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useActiveChatSelector(
          SESSION_ID,
          (state) => ({ count: state?.attachments.length ?? 0 }),
          (a, b) => a.count === b.count,
        );
      },
      { wrapper: ActiveChatsProvider },
    );

    expect(result.current).toEqual({ count: 0 });
    const renderCountAfterMount = renderCount;
    const valueAfterMount = result.current;

    act(() => {
      // A brand-new (but same-length) array — the default shallow-equal
      // comparator would treat this as changed; the custom comparator here
      // should not.
      activeChatsStore.updateChat(SESSION_ID, { attachments: [] });
    });

    expect(result.current).toBe(valueAfterMount);
    expect(renderCount).toBe(renderCountAfterMount);
  });

  test('returns null for a session that does not exist', () => {
    const { result } = renderHook(
      () =>
        useActiveChatSelector(
          'missing-session',
          (state) => state?.input ?? null,
        ),
      { wrapper: ActiveChatsProvider },
    );

    expect(result.current).toBeNull();
  });
});
