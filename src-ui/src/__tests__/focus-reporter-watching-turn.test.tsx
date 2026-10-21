/**
 * @vitest-environment jsdom
 *
 * Owner decision: a focused, visible Station window showing a running turn
 * keeps the person present without input, so a watched turn does not buzz
 * their other devices when it ends; once nothing runs in front of it, the
 * old input rule applies again and the lease lapses. Driven through the
 * real reporter hook, the real chat and navigation stores and the real
 * orchestration event entry point that opens and closes the turn.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { navigationStore } from '../contexts/NavigationContext';
import {
  FOCUS_HEARTBEAT_MS,
  FOCUS_REPORT_DEBOUNCE_MS,
  FOCUS_WATCH_RENEWAL_MAX,
} from '../hooks/focusReporter';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { resetTurnAttentionNotifications } from '../hooks/orchestration/turnAttentionNotifications';
import type { OrchestrationEvent } from '../hooks/orchestration/types';
import { useFocusReporter } from '../hooks/useFocusReporter';

const CHAT = 'chat-watched';
let sequence = 0;

function emit(event: Record<string, unknown>) {
  sequence += 1;
  act(() => {
    handleOrchestrationEvent('', {
      eventId: `event-${sequence}`,
      provider: 'codex',
      createdAt: '2026-10-19T00:00:00.000Z',
      threadId: CHAT,
      ...event,
    } as OrchestrationEvent);
  });
}

function sentStates(): string[] {
  return mocks.authenticatedFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).state,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  mocks.authenticatedFetch
    .mockReset()
    .mockImplementation(async () => new Response(null, { status: 204 }));
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
  resetTurnAttentionNotifications();
  activeChatsStore.removeChat(CHAT);
  navigationStore.setActiveChat(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a focused window showing a running turn keeps its lease without input, and lets it lapse once the turn ends', async () => {
  renderHook(() => useFocusReporter());
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(FOCUS_REPORT_DEBOUNCE_MS);
  mocks.authenticatedFetch.mockClear();

  // Nothing running and no input: the focused window is left to lapse.
  await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS);
  expect(sentStates()).toEqual([]);

  emit({ method: 'turn.started', turnId: 'turn-1', prompt: 'Refactor' });
  // A long turn, watched without touching the window: renewed every beat.
  await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS * 3);
  expect(sentStates()).toEqual(['focused', 'focused', 'focused']);

  emit({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' });
  mocks.authenticatedFetch.mockClear();
  await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS * 2);
  expect(sentStates()).toEqual([]);
});

test('a running turn in a chat that is not on screen does not hold the lease', async () => {
  navigationStore.setActiveChat('some-other-chat');
  renderHook(() => useFocusReporter());
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(FOCUS_REPORT_DEBOUNCE_MS);
  mocks.authenticatedFetch.mockClear();

  emit({ method: 'turn.started', turnId: 'turn-1', prompt: 'Refactor' });
  await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS * 2);
  expect(sentStates()).toEqual([]);
});

test('a turn whose end never arrives holds the lease for at most the renewal cap; input restarts it', async () => {
  // One hour at the 60 s beat (pinned beside the constant it bounds).
  expect(FOCUS_WATCH_RENEWAL_MAX).toBe(60);
  renderHook(() => useFocusReporter());
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(FOCUS_REPORT_DEBOUNCE_MS);
  emit({ method: 'turn.started', turnId: 'turn-1', prompt: 'Refactor' });
  mocks.authenticatedFetch.mockClear();

  await vi.advanceTimersByTimeAsync(
    FOCUS_HEARTBEAT_MS * (FOCUS_WATCH_RENEWAL_MAX + 5),
  );
  expect(sentStates()).toHaveLength(FOCUS_WATCH_RENEWAL_MAX);

  // The person is back: input renews at once and restarts the allowance.
  mocks.authenticatedFetch.mockClear();
  await act(async () => {
    window.dispatchEvent(new Event('keydown'));
  });
  await vi.advanceTimersByTimeAsync(FOCUS_HEARTBEAT_MS * 5);
  expect(sentStates().length).toBeGreaterThanOrEqual(5);
});
