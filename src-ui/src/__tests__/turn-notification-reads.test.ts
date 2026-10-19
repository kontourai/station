/**
 * @vitest-environment jsdom
 *
 * A turn-completion record is read once its chat is on screen in a focused
 * window, so the server cancels a watched failure's escalation to the
 * person's other devices. Driven through the real chat and navigation
 * stores; only the read request is stubbed.
 */

import type { Notification } from '@kontourai/station-contracts/notification';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { markNotificationRead } = vi.hoisted(() => ({
  markNotificationRead: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/notification-read', () => ({
  markNotificationRead,
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { navigationStore } from '../contexts/NavigationContext';
import { startTurnNotificationReads } from '../hooks/orchestration/turnNotificationReads';

const CHAT = 'thread-watched';
let focused = true;

function turnRecord(
  id: string,
  overrides: Partial<Notification> & { readAt?: string } = {},
): Notification {
  const { readAt, ...rest } = overrides;
  return {
    id,
    source: 'turn-completion',
    category: 'turn-failed',
    title: 'Your agent needs attention',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: '2026-10-19T00:00:00.000Z',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    metadata: {
      sessionId: CHAT,
      envelope: {
        v: 1,
        source: { kind: 'system', subsystem: 'turn-completion' },
        audience: { kind: 'session-readers', sessionId: CHAT },
        urgency: 'failed',
        target: { kind: 'session', sessionId: CHAT },
        interrupt: 'default',
        ...(readAt ? { readAt, readBy: 'device:phone' } : {}),
      },
    },
    ...rest,
  } as Notification;
}

const readIds = () =>
  markNotificationRead.mock.calls.map(([input]) => input.id);
let stop: (() => void) | undefined;

beforeEach(() => {
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  markNotificationRead.mockReset().mockResolvedValue('read');
  activeChatsStore.initChat(CHAT, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Watched chat',
    conversationId: CHAT,
    currentSessionId: CHAT,
  });
  navigationStore.setDockState(true);
  navigationStore.setActiveChat(CHAT);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  activeChatsStore.removeChat(CHAT);
  navigationStore.setActiveChat(null);
  vi.restoreAllMocks();
});

test('a turn ending in the chat on screen in a focused window is marked read once', () => {
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  reads.update([turnRecord('n-1')]);
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual(['n-1']);
});

test('not while the window is unfocused; focusing it reads it', () => {
  focused = false;
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
  focused = true;
  window.dispatchEvent(new Event('focus'));
  expect(readIds()).toEqual(['n-1']);
});

test('a chat that is not on screen is not read until it is opened', () => {
  navigationStore.setActiveChat('another-chat');
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
  navigationStore.setActiveChat(CHAT);
  expect(readIds()).toEqual(['n-1']);
});

test('only unread turn-completion records are read', () => {
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  reads.update([
    turnRecord('already-read', { readAt: '2026-10-19T00:00:01.000Z' }),
    turnRecord('dismissed', { status: 'dismissed' }),
    turnRecord('other-writer', { source: 'agent' }),
    turnRecord('n-1'),
  ]);
  expect(readIds()).toEqual(['n-1']);
});

test('a failed read is retried on the next change', async () => {
  markNotificationRead.mockRejectedValueOnce(new Error('offline'));
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  reads.update([turnRecord('n-1')]);
  await Promise.resolve();
  await Promise.resolve();
  reads.evaluate();
  expect(readIds()).toEqual(['n-1', 'n-1']);
});
