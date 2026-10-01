// @vitest-environment jsdom

/**
 * Unread must mean "changed while you were not looking". Acknowledgement was
 * written only when an inbox row was activated, so a chat read and replied
 * to in the dock went unread the moment the user switched away. These drive
 * the display-acknowledgement hook against a stand-in for the conversation
 * inventory (the server's `acknowledgedAt`, re-read after each write) and
 * read the result the way a row does: through `workStatus`.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HomeWorkItem } from '../home-view-model';
import { useAcknowledgeDisplayedConversation } from '../useWorkFacts';
import { workStatus } from '../work-status';

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** The inventory: each conversation's version, and what was acknowledged. */
function inventory() {
  const updatedAt = new Map<string, string>();
  const acknowledgedAt = new Map<string, number>();
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
      lifecycleLabel: 'Recent',
      conversationUpdatedAt: version,
      ...(acknowledgedAt.has(id)
        ? { acknowledgedAt: acknowledgedAt.get(id) }
        : {}),
    }));
  return { updatedAt, acknowledge, items };
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
});
