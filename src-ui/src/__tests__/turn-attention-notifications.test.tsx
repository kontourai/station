/**
 * @vitest-environment jsdom
 *
 * What the toast stack shows when a chat's tool calls and turns end, driven
 * through the real event entry point (`handleOrchestrationEvent`), the real
 * chat, navigation and toast stores, and the real `NotificationContainer`.
 * Only the container's navigation hook is stubbed: the toasts navigate
 * through `navigationStore` itself.
 */

import type { OrchestrationEvent } from '@kontourai/station-contracts/runtime-events';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/NavigationContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/NavigationContext')>()),
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));

import { NotificationContainer } from '../components/notifications/NotificationContainer';
import { activeChatsStore } from '../contexts/active-chats-store';
import { navigationStore } from '../contexts/NavigationContext';
import { ToastProvider, toastStore } from '../contexts/ToastContext';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import {
  resetTurnAttentionNotifications,
  STOP_FACT_GRACE_MS,
} from '../hooks/orchestration/turnAttentionNotifications';

const BG = 'chat-background';
const FG = 'chat-foreground';
let sequence = 0;

function emit(event: Record<string, unknown>) {
  sequence += 1;
  act(() => {
    handleOrchestrationEvent('', {
      eventId: `event-${sequence}`,
      provider: 'codex',
      createdAt: '2026-09-24T00:00:00.000Z',
      threadId: BG,
      ...event,
    } as OrchestrationEvent);
  });
}

function startTurn(turnId: string, metadata?: Record<string, unknown>) {
  emit({
    method: 'turn.started',
    turnId,
    ...(metadata ? { metadata } : { prompt: 'Tidy the auth module' }),
  });
}

function toastCards() {
  return [
    ...screen.queryAllByTestId('toast-card'),
    ...screen.queryAllByTestId('toast-card-collapsed'),
  ];
}

function passGrace() {
  act(() => {
    vi.advanceTimersByTime(STOP_FACT_GRACE_MS + 1);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  for (const id of [BG, FG]) {
    activeChatsStore.initChat(id, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: id === BG ? 'Refactor auth' : 'Other chat',
      conversationId: id,
      currentSessionId: id,
    });
  }
  // The dock is open on a DIFFERENT chat: BG is in the background.
  navigationStore.setDockState(true);
  navigationStore.setActiveChat(FG);
  render(
    <ToastProvider>
      <NotificationContainer />
    </ToastProvider>,
  );
});

afterEach(() => {
  act(() => {
    toastStore.dismissAll();
    toastStore.clearHistory();
  });
  resetTurnAttentionNotifications();
  activeChatsStore.removeChat(BG);
  activeChatsStore.removeChat(FG);
  navigationStore.setActiveChat(null);
  vi.useRealTimers();
});

describe('tool call toasts', () => {
  test.each(['success', 'cancelled', 'unresolved'] as const)(
    'a %s tool call raises no toast',
    (status) => {
      startTurn('turn-1');
      emit({
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: 'call-1',
        toolCallId: 'call-1',
        toolName: 'shell_exec',
      });
      emit({
        method: 'tool.completed',
        turnId: 'turn-1',
        itemId: 'call-1',
        toolCallId: 'call-1',
        toolName: 'shell_exec',
        status,
        output: { output: 'done' },
      });
      expect(toastCards()).toHaveLength(0);
    },
  );

  test('a failed tool call raises one toast naming the tool and the reason', () => {
    startTurn('turn-1');
    emit({
      method: 'tool.completed',
      turnId: 'turn-1',
      itemId: 'call-1',
      toolCallId: 'call-1',
      toolName: 'shell_exec',
      status: 'error',
      error: 'Permission denied',
    });
    expect(toastCards()).toHaveLength(1);
    expect(screen.getByText('Dev Agent failed shell exec')).toBeTruthy();
    expect(screen.getByText('Permission denied')).toBeTruthy();
  });
});

describe('end-of-turn toasts', () => {
  test('a background turn that finishes raises one toast with the chat, agent, snippet and Open', () => {
    startTurn('turn-1');
    const answer = `## Done\n\nI **renamed** \`loginUser\` to [signIn](https://x.test) across ${'the module and its tests, '.repeat(6)}`;
    emit({ method: 'turn.completed', turnId: 'turn-1', outputText: answer });

    expect(toastCards()).toHaveLength(1);
    expect(screen.getByText('Agent turn')).toBeTruthy();
    expect(screen.getByText('Dev Agent (Codex) finished')).toBeTruthy();
    const snippet = screen.getByText(/^Done I renamed loginUser to signIn/);
    expect(snippet.textContent?.length).toBeLessThanOrEqual(100);
    expect(snippet.textContent?.endsWith('…')).toBe(true);
    expect(screen.getByText('“Refactor auth”')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(navigationStore.getSnapshot().activeChat).toBe(BG);
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(toastCards()).toHaveLength(0);
  });

  test('the foreground chat never toasts its own turn end', () => {
    navigationStore.setActiveChat(BG);
    startTurn('turn-1');
    emit({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' });
    emit({ method: 'turn.aborted', turnId: 'turn-2', reason: 'crashed' });
    passGrace();
    expect(toastCards()).toHaveLength(0);
  });

  test('a chat with the dock closed counts as background', () => {
    navigationStore.setActiveChat(BG);
    navigationStore.setDockState(false);
    startTurn('turn-1');
    emit({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' });
    expect(toastCards()).toHaveLength(1);
  });

  test('one toast per turn, however many terminals arrive for it', () => {
    startTurn('turn-1');
    emit({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' });
    emit({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' });
    startTurn('turn-2');
    emit({
      method: 'runtime.error',
      turnId: 'turn-2',
      severity: 'error',
      message: 'Engine exited',
    });
    emit({ method: 'turn.aborted', turnId: 'turn-2', reason: 'Engine exited' });
    passGrace();
    expect(screen.getAllByText('Dev Agent (Codex) finished')).toHaveLength(1);
    expect(toastCards()).toHaveLength(2);
  });

  test('a failed turn toasts with its reason', () => {
    startTurn('turn-1');
    emit({
      method: 'runtime.error',
      turnId: 'turn-1',
      severity: 'error',
      message: 'Usage limit reached. Try again at 5pm.',
    });
    expect(toastCards()).toHaveLength(0);
    passGrace();
    expect(
      screen.getByText(
        'Dev Agent (Codex) failed: Usage limit reached. Try again at 5pm.',
      ),
    ).toBeTruthy();
  });

  test('a deferred-retriable Codex error is not the end of the turn', () => {
    startTurn('turn-1');
    emit({
      method: 'runtime.error',
      turnId: 'turn-1',
      severity: 'error',
      message: 'Reconnecting…',
      retriable: true,
    });
    passGrace();
    expect(toastCards()).toHaveLength(0);
  });

  // Each case settles its grace window before the next begins: a Stop still
  // in flight (`stopPending`) would otherwise also cover the earlier cases.
  test("this user's own Stop raises nothing, whichever fact arrives first", () => {
    // Cooperative: the engine's abort lands before Station's settled stop.
    startTurn('turn-1');
    emit({ method: 'turn.aborted', turnId: 'turn-1', reason: 'interrupted' });
    emit({
      method: 'session.stop-settled',
      turnId: 'turn-1',
      outcome: 'cooperative',
      initiatedBy: 'user',
    });
    passGrace();
    expect(toastCards()).toHaveLength(0);

    // Forced: the settled stop lands first.
    startTurn('turn-2');
    emit({
      method: 'session.stop-settled',
      turnId: 'turn-2',
      outcome: 'forced',
      initiatedBy: 'user',
    });
    emit({ method: 'turn.aborted', turnId: 'turn-2', reason: 'forced' });
    passGrace();
    expect(toastCards()).toHaveLength(0);

    // This client's own Stop in flight.
    startTurn('turn-3');
    act(() => activeChatsStore.updateChat(BG, { stopPending: true }));
    emit({ method: 'turn.aborted', turnId: 'turn-3', reason: 'interrupted' });
    passGrace();
    expect(toastCards()).toHaveLength(0);
  });

  test("a stall-watchdog stop is not the user's, and still toasts", () => {
    startTurn('turn-1');
    emit({ method: 'turn.aborted', turnId: 'turn-1', reason: 'no progress' });
    emit({
      method: 'session.stop-settled',
      turnId: 'turn-1',
      outcome: 'cooperative',
      initiatedBy: 'stall',
    });
    passGrace();
    expect(
      screen.getByText('Dev Agent (Codex) stopped: no progress'),
    ).toBeTruthy();
  });

  test('a turn stopped by something other than the user toasts why', () => {
    startTurn('turn-1');
    emit({
      method: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'The engine ended before the turn started.',
    });
    passGrace();
    expect(
      screen.getByText(
        'Dev Agent (Codex) stopped: The engine ended before the turn started.',
      ),
    ).toBeTruthy();
  });

  test('a turn the engine opened on its own reads as a reply', () => {
    startTurn('turn-p', { trigger: 'provider' });
    emit({
      method: 'turn.completed',
      turnId: 'turn-p',
      outputText: 'The background build finished green.',
      metadata: { trigger: 'provider' },
    });
    expect(
      screen.getByText('Dev Agent (Codex) replied on its own'),
    ).toBeTruthy();
    expect(
      screen.getByText('The background build finished green.'),
    ).toBeTruthy();
  });
});
