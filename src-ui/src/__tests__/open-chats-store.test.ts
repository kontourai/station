// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  countOpenChatAttention,
  openChatsStore,
} from '../contexts/open-chats-store';
import type { AgentSummary } from '../types';
import { focusChatEventDetailForAction } from '../views/home/work-item-open-policy';

const agents = [
  { slug: 'station', name: 'Station' },
] as unknown as AgentSummary[];
const created: string[] = [];

function addChat(
  id: string,
  timestamp: number,
  status: 'error' | 'queued' | 'idle' | 'sending' = 'idle',
) {
  created.push(id);
  activeChatsStore.initChat(id, {
    agentSlug: 'station',
    agentName: 'Station',
    title: id,
  });
  activeChatsStore.updateChat(id, {
    status,
    messages: [{ role: 'user', content: id, timestamp }],
  });
}

afterEach(() => {
  for (const id of created.splice(0)) activeChatsStore.removeChat(id);
});

describe('openChatsStore', () => {
  test('owns membership and orders newest activity first', () => {
    addChat('older', 100);
    addChat('newer', 200);

    expect(
      openChatsStore.select(agents).map((item) => item.chatSessionId),
    ).toEqual(['newer', 'older']);

    activeChatsStore.removeChat('newer');
    expect(
      openChatsStore.select(agents).map((item) => item.chatSessionId),
    ).toEqual(['older']);
  });

  test('routes the exact focus target and collection-open action', () => {
    const focus = vi.fn();
    const openCollection = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection,
    });

    openChatsStore.focus({ sessionId: 'wanted' });
    openChatsStore.openCollection();

    expect(focus).toHaveBeenCalledWith({ sessionId: 'wanted' });
    expect(openCollection).toHaveBeenCalledOnce();
    unregister();
  });

  test('routes a resolved focus transition to the intended session', () => {
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    const target = focusChatEventDetailForAction({
      kind: 'focus',
      chatSessionId: 'intended-session',
    });
    expect(target).not.toBeNull();

    openChatsStore.focus(target!);

    expect(focus).toHaveBeenCalledWith({ sessionId: 'intended-session' });
    unregister();
  });

  test('derives the shared unread attention count once', () => {
    expect(
      countOpenChatAttention([
        { hasUnread: true },
        { hasUnread: false },
        { hasUnread: true },
      ]),
    ).toBe(2);
  });

  test('delivers a focus transition requested before navigation mounts', () => {
    addChat('queued', 400);
    openChatsStore.focus({ sessionId: 'queued' });
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });

    expect(focus).toHaveBeenCalledWith({ sessionId: 'queued' });
    unregister();
  });

  test('drops a queued focus when its chat closes before navigation mounts', () => {
    addChat('closed-before-mount', 500);
    openChatsStore.focus({ sessionId: 'closed-before-mount' });
    activeChatsStore.removeChat('closed-before-mount');
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });

    expect(focus).not.toHaveBeenCalled();
    unregister();

    const nextFocus = vi.fn();
    const unregisterNext = openChatsStore.registerNavigation({
      focus: nextFocus,
      openCollection: vi.fn(),
    });
    expect(nextFocus).not.toHaveBeenCalled();
    unregisterNext();
  });

  test('notifies every subscriber when membership changes without DOM events', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = openChatsStore.subscribe(first);
    const unsubscribeSecond = openChatsStore.subscribe(second);

    addChat('propagated', 300);

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    unsubscribeFirst();
    unsubscribeSecond();
  });
});
