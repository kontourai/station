/**
 * @vitest-environment jsdom
 *
 * A turn-completion record is read once the person attends to its chat —
 * on screen in a focused window WITH recent input — so the server cancels a
 * watched failure's escalation to their other devices; focus alone (a
 * window left open on a long turn) never reads it. Driven through the real
 * chat and navigation stores and real DOM input events; only the read
 * request is stubbed.
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
import { FOCUS_INPUT_RECENCY_MS } from '../hooks/focusReporter';
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
/** Real input, as the person would make it; moves past the recheck throttle. */
function input() {
  vi.advanceTimersByTime(1_000);
  window.dispatchEvent(new Event('keydown'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start() {
  const reads = startTurnNotificationReads();
  stop = reads.stop;
  return reads;
}

test('a failure in the chat on screen, in a focused window with recent input, is read once', () => {
  const reads = start();
  input();
  reads.update([turnRecord('n-1')]);
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual(['n-1']);
});

test('a focused window nobody is touching does not read a failure; the first input does', () => {
  const reads = start();
  reads.update([turnRecord('n-1')]);
  window.dispatchEvent(new Event('focus'));
  expect(readIds()).toEqual([]);
  input();
  expect(readIds()).toEqual(['n-1']);
});

test('input older than the recency window no longer counts as attention', () => {
  const reads = start();
  input();
  vi.advanceTimersByTime(FOCUS_INPUT_RECENCY_MS + 1);
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
});

test('not while the window is unfocused, even with input', () => {
  focused = false;
  const reads = start();
  input();
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
  focused = true;
  input();
  expect(readIds()).toEqual(['n-1']);
});

test('a chat that is not on screen is not read until it is opened', () => {
  navigationStore.setActiveChat('another-chat');
  const reads = start();
  input();
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
  navigationStore.setActiveChat(CHAT);
  expect(readIds()).toEqual(['n-1']);
});

test('only unread turn-completion records are read', () => {
  const reads = start();
  input();
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
  const reads = start();
  input();
  reads.update([turnRecord('n-1')]);
  await Promise.resolve();
  await Promise.resolve();
  reads.evaluate();
  expect(readIds()).toEqual(['n-1', 'n-1']);
});
