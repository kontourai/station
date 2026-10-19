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
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useNotificationsQuery: () => ({ data: [] }),
}));

import { renderHook } from '@testing-library/react';
import { activeChatsStore } from '../contexts/active-chats-store';
import { navigationStore } from '../contexts/NavigationContext';
import { FOCUS_INPUT_RECENCY_MS } from '../hooks/focusReporter';
import {
  INPUT_RECHECK_MS,
  startTurnNotificationReads,
} from '../hooks/orchestration/turnNotificationReads';
import { useTurnNotificationReads } from '../hooks/useTurnNotificationReads';
import { subscribeToNotificationOpen } from '../lib/notificationOpen';

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
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
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
  window.history.replaceState(null, '', '/');
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

// An OS alert's open link names its record (`openedNotification`, added by
// the server's link builder). Opening it reads that record with no input.
test('a Web Push tap: the page loads on the link, the parameter leaves the URL on mount, and the record is read', async () => {
  window.history.replaceState(
    null,
    '',
    '/?surface=activity&session=thread-watched&openedNotification=n-tapped',
  );
  const view = renderHook(() => useTurnNotificationReads());
  // Taken off the URL on mount, before the reader's chunk has loaded.
  const params = new URLSearchParams(window.location.search);
  expect(params.has('openedNotification')).toBe(false);
  expect(params.get('session')).toBe('thread-watched');
  await vi.dynamicImportSettled();
  expect(readIds()).toEqual(['n-tapped']);
  view.unmount();
});

test('an alert opened before the reader loads is still read once it does', async () => {
  const view = renderHook(() => useTurnNotificationReads());
  navigationStore.navigate('/', {
    surface: 'activity',
    session: 'thread-watched',
    openedNotification: 'n-early',
  });
  expect(
    new URLSearchParams(window.location.search).has('openedNotification'),
  ).toBe(false);
  await vi.dynamicImportSettled();
  expect(readIds()).toEqual(['n-early']);
  view.unmount();
});

test('a desktop alert click: the app navigates to the link and reads the record it names', async () => {
  const view = renderHook(() => useTurnNotificationReads());
  await vi.dynamicImportSettled();
  const unsubscribe = subscribeToNotificationOpen(
    (pathname, params) => navigationStore.navigate(pathname, params),
    Promise.resolve({
      listen: async () => () => {},
      take: async () =>
        '/?surface=activity&session=thread-watched&openedNotification=n-clicked',
    }),
  );
  await vi.waitFor(() => expect(readIds()).toEqual(['n-clicked']));
  expect(
    new URLSearchParams(window.location.search).has('openedNotification'),
  ).toBe(false);
  unsubscribe();
  view.unmount();
});

test('plain focus with no opened link and no input reads nothing', () => {
  const reads = start();
  reads.update([turnRecord('n-1')]);
  window.dispatchEvent(new Event('focus'));
  navigationStore.setActiveChat(CHAT);
  expect(readIds()).toEqual([]);
});

test('input inside the recheck window is checked once more when it closes', () => {
  focused = false;
  const reads = start();
  input();
  reads.update([turnRecord('n-1')]);
  expect(readIds()).toEqual([]);
  // The window gains focus with no event, and the person types again before
  // the throttle window closes: only the trailing check can see it.
  focused = true;
  window.dispatchEvent(new Event('keydown'));
  expect(readIds()).toEqual([]);
  vi.advanceTimersByTime(INPUT_RECHECK_MS);
  expect(readIds()).toEqual(['n-1']);
});
