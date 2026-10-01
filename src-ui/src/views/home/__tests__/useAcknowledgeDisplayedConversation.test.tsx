// @vitest-environment jsdom

/**
 * Unread must mean "changed while you were not looking". Acknowledgement was
 * written only when an inbox row was activated, so a chat read and replied
 * to in the dock went unread the moment the user switched away. These drive
 * the display-acknowledgement hook against a stand-in for the conversation
 * inventory (the server's `acknowledgedAt`, re-read after each write) and
 * read the result the way a row does: through `workStatus`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeWorkItem } from '../home-view-model';
import {
  useAcknowledgeDisplayedConversation,
  useInventoryAcknowledgeWriter,
} from '../useWorkFacts';
import { workStatus } from '../work-status';

const acknowledgeRequest = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  acknowledgeConversation: acknowledgeRequest,
}));

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** The inventory: each conversation's version, and what was acknowledged. */
function inventory() {
  const updatedAt = new Map<string, string>();
  const acknowledgedAt = new Map<string, number>();
  /** Conversations with a turn in flight. */
  const running = new Set<string>();
  const acknowledge = vi.fn((item: HomeWorkItem) => {
    acknowledgedAt.set(item.id, Date.parse(item.conversationUpdatedAt!));
  });
  const items = (): HomeWorkItem[] =>
    [...updatedAt].map(([id, version]) => ({
      id,
      conversationId: id,
      chatSessionId: `tab-${id}`,
      kind: 'chat',
      kindLabel: 'Direct chat',
      title: id,
      projectLabel: 'station',
      agentLabel: 'Claude Code',
      modelLabel: 'Opus',
      updatedAt: Date.parse(version),
      lifecycleLabel: running.has(id) ? 'Running' : 'Recent',
      conversationUpdatedAt: version,
      ...(acknowledgedAt.has(id)
        ? { acknowledgedAt: acknowledgedAt.get(id) }
        : {}),
    }));
  return { updatedAt, running, acknowledge, items };
}

function mount(store: ReturnType<typeof inventory>, displayed: string | null) {
  return renderHook(
    ({ displayedChatSessionId }) =>
      useAcknowledgeDisplayedConversation({
        items: store.items(),
        displayedChatSessionId,
        acknowledge: store.acknowledge,
      }),
    { initialProps: { displayedChatSessionId: displayed } },
  );
}

const unread = (store: ReturnType<typeof inventory>, id: string) =>
  workStatus(store.items().find((item) => item.id === id)!, T0 + 600_000)
    .unread;

describe('acknowledging the conversation on screen', () => {
  it('a chat you reply in is not unread when you switch away', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    store.updatedAt.set('b', at(0));
    const hook = mount(store, 'tab-a');
    // Opening it acknowledged the version on screen.
    expect(store.acknowledge).toHaveBeenCalledTimes(1);
    // You send, and the reply lands, while it is still on screen.
    store.updatedAt.set('a', at(30));
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    store.updatedAt.set('a', at(60));
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(store.acknowledge).toHaveBeenCalledTimes(3);
    // Switch to the other chat.
    hook.rerender({ displayedChatSessionId: 'tab-b' });
    expect(unread(store, 'a')).toBe(false);
  });

  it('a turn that arrives while you are elsewhere is unread, and returning clears it', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    store.updatedAt.set('b', at(0));
    const hook = mount(store, 'tab-a');
    hook.rerender({ displayedChatSessionId: 'tab-b' });
    expect(unread(store, 'a')).toBe(false);

    // A new turn lands in A while B is on screen.
    store.updatedAt.set('a', at(120));
    store.acknowledge.mockClear();
    hook.rerender({ displayedChatSessionId: 'tab-b' });
    expect(store.acknowledge.mock.calls.map(([item]) => item.id)).not.toContain(
      'a',
    );
    expect(unread(store, 'a')).toBe(true);

    // Coming back to A acknowledges exactly that version, once.
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(
      store.acknowledge.mock.calls
        .filter(([item]) => item.id === 'a')
        .map(([item]) => item.conversationUpdatedAt),
    ).toEqual([at(120)]);
    expect(unread(store, 'a')).toBe(false);
  });

  it('nothing is acknowledged while nothing is displayed', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    const hook = mount(store, null);
    store.updatedAt.set('a', at(30));
    hook.rerender({ displayedChatSessionId: null });
    expect(store.acknowledge).not.toHaveBeenCalled();
    expect(unread(store, 'a')).toBe(true);
  });

  it('writes each version once even while the acknowledgement has not come back', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    // A write the inventory has not reflected yet.
    store.acknowledge.mockImplementation(() => {});
    const hook = mount(store, 'tab-a');
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(store.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('a failed write is not retried for that version, and the next version is a fresh attempt', async () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    store.acknowledge.mockImplementation(async () => {
      throw new Error('offline');
    });
    const hook = mount(store, 'tab-a');
    await act(async () => {});
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    await act(async () => {});
    expect(store.acknowledge).toHaveBeenCalledTimes(1);
    store.updatedAt.set('a', at(30));
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    await act(async () => {});
    expect(
      store.acknowledge.mock.calls.map(([item]) => item.conversationUpdatedAt),
    ).toEqual([at(0), at(30)]);
  });
});

describe('a turn in flight is a new version on every event', () => {
  it('N version bumps during an open turn produce one acknowledgement, after it settles', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    const hook = mount(store, 'tab-a');
    expect(store.acknowledge).toHaveBeenCalledTimes(1);
    store.acknowledge.mockClear();

    // The user sends; the turn streams. The server stamps the session's
    // updatedAt on every event, so each read is a newer version.
    store.running.add('a');
    for (let second = 1; second <= 40; second += 1) {
      store.updatedAt.set('a', at(second));
      hook.rerender({ displayedChatSessionId: 'tab-a' });
    }
    expect(store.acknowledge).not.toHaveBeenCalled();

    // The turn ends: the settled version is acknowledged, once.
    store.running.delete('a');
    store.updatedAt.set('a', at(41));
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(
      store.acknowledge.mock.calls.map(([item]) => item.conversationUpdatedAt),
    ).toEqual([at(41)]);
  });
});

describe('a conversation nobody is looking at is not acknowledged', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  afterEach(() => setVisibility('visible'));

  it('a completion landing in a background tab stays unread until the page is shown', () => {
    const store = inventory();
    store.updatedAt.set('a', at(0));
    const hook = mount(store, 'tab-a');
    store.acknowledge.mockClear();

    setVisibility('hidden');
    store.updatedAt.set('a', at(60));
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(store.acknowledge).not.toHaveBeenCalled();
    expect(unread(store, 'a')).toBe(true);

    setVisibility('visible');
    expect(
      store.acknowledge.mock.calls.map(([item]) => item.conversationUpdatedAt),
    ).toEqual([at(60)]);
  });

  it('nothing is acknowledged while the host says the chat is covered', () => {
    // The host passes no displayed conversation while the task switcher
    // sheet is over the chat.
    const store = inventory();
    store.updatedAt.set('a', at(0));
    const hook = mount(store, null);
    store.updatedAt.set('a', at(60));
    hook.rerender({ displayedChatSessionId: null });
    expect(store.acknowledge).not.toHaveBeenCalled();
    hook.rerender({ displayedChatSessionId: 'tab-a' });
    expect(store.acknowledge).toHaveBeenCalledTimes(1);
  });
});

describe('the dock’s acknowledgement write', () => {
  it('sends the displayed version and patches the cached inventory without invalidating it', async () => {
    acknowledgeRequest.mockClear();
    const client = new QueryClient();
    const key = ['conversation-inventory'];
    client.setQueryData(key, {
      pages: [
        {
          items: [
            { id: 'a', updatedAt: at(60) },
            { id: 'b', updatedAt: at(0) },
          ],
          hasMore: false,
        },
      ],
      pageParams: [undefined],
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useInventoryAcknowledgeWriter(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(() =>
      result.current({
        id: 'a',
        conversationUpdatedAt: at(60),
      } as HomeWorkItem),
    );
    expect(acknowledgeRequest).toHaveBeenCalledWith('a', at(60));
    expect(client.getQueryData(key)).toEqual({
      pages: [
        {
          items: [
            { id: 'a', updatedAt: at(60), acknowledgedAt: at(60) },
            { id: 'b', updatedAt: at(0) },
          ],
          hasMore: false,
        },
      ],
      pageParams: [undefined],
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
