// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { conversationConnection } from '../../../components/conversation/__tests__/fixtures';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import type { OrchestrationEvent } from '../types';

const recordReplayRuntime = vi.hoisted(() => vi.fn());
vi.mock('../replay/capture-tap', () => ({ recordReplayRuntime }));

import {
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
} from '../eventHandlers';

const THREAD_ID = 'buffered-production-thread';
const API_BASE = 'https://buffered.example.test';

function event(
  method: string,
  overrides: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    provider: 'claude',
    threadId: THREAD_ID,
    turnId: 'turn-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    method,
    ...overrides,
  } as OrchestrationEvent;
}

describe('production orchestration event seam — buffered delivery', () => {
  test.each(['direct', 'relay'] as const)(
    '%s lifecycle boundaries settle their own tab without reaching a colliding host tab',
    (route) => {
      const station = conversationConnection(route);
      activeChatsStore.initChat('remote-buffered-tab', {
        agentSlug: 'claude',
        agentName: 'Claude',
        title: 'Receiver',
        conversationId: THREAD_ID,
        currentSessionId: THREAD_ID,
        stationBinding: station.binding,
      });
      activeChatsStore.updateChat('remote-buffered-tab', {
        status: 'sending',
        sendAwaitingTurnStart: true,
      });
      const binding = {
        conversationId: THREAD_ID,
        currentSessionId: THREAD_ID,
      };
      handleOrchestrationEvent(
        station.targetApiBase,
        event('turn.started', { prompt: 'Receiver prompt' }),
        undefined,
        binding,
        1,
        station,
      );
      expect(
        activeChatsStore.getSnapshot()['remote-buffered-tab']
          .orchestrationTurnOpen,
      ).toBe(true);
      handleOrchestrationEvent(
        station.targetApiBase,
        event('content.text-delta', {
          itemId: 'answer',
          delta: 'Receiver answer',
        }),
        undefined,
        binding,
        2,
        station,
      );
      // An unrelated store notification must not retire the buffered owner.
      activeChatsStore.updateChat(THREAD_ID, { input: 'Host draft' });
      handleOrchestrationEvent(
        station.targetApiBase,
        event('turn.completed'),
        undefined,
        binding,
        3,
        station,
      );
      expect(
        activeChatsStore.getSnapshot()['remote-buffered-tab'],
      ).toMatchObject({
        status: 'idle',
        orchestrationTurnOpen: false,
        sendAwaitingTurnStart: undefined,
      });
      expect(
        activeChatsStore.getSnapshot()['remote-buffered-tab'].messages,
      ).toContainEqual(expect.objectContaining({ content: 'Receiver answer' }));
      expect(
        activeChatsStore.getSnapshot()[THREAD_ID].messages,
      ).toBeUndefined();
      expect(
        activeChatsStore.getSnapshot()[THREAD_ID].orchestrationTurnOpen,
      ).toBeUndefined();
      activeChatsStore.removeChat('remote-buffered-tab');
    },
  );
  beforeEach(async () => {
    recordReplayRuntime.mockClear();
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Buffered chat',
    });
    const featureSettings = deviceSettingsStore.get('featureSettings');
    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      smoothReveal: false,
      bufferedDelivery: true,
    });
    // The optional chunk deliberately falls through during its first event.
    // A lifecycle event starts the load without delaying that control fact;
    // later deltas exercise the loaded buffered path.
    handleOrchestrationEvent(
      API_BASE,
      event('session.started', { sessionId: THREAD_ID }),
    );
    await vi.dynamicImportSettled();
    recordReplayRuntime.mockClear();
  });

  afterEach(() => {
    activeChatsStore.removeChat('remote-buffered-tab');
    settleSemanticDeliveryBuffer(API_BASE);
    activeChatsStore.removeChat(THREAD_ID);
    deviceSettingsStore.reset('featureSettings');
  });

  test('captures raw deltas immediately while the visible transcript waits for tool and terminal boundaries', () => {
    const first = event('content.text-delta', {
      itemId: 'answer',
      delta: 'Held ',
    });
    const second = event('content.text-delta', {
      itemId: 'answer',
      delta: 'answer',
    });
    handleOrchestrationEvent(API_BASE, first);
    handleOrchestrationEvent(API_BASE, second);

    expect(recordReplayRuntime).toHaveBeenNthCalledWith(
      1,
      API_BASE,
      first,
      undefined,
    );
    expect(recordReplayRuntime).toHaveBeenNthCalledWith(
      2,
      API_BASE,
      second,
      undefined,
    );
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage,
    ).toBeUndefined();

    handleOrchestrationEvent(
      API_BASE,
      event('tool.started', {
        itemId: 'tool-1',
        toolCallId: 'call-1',
        toolName: 'read_file',
        input: {},
      }),
    );
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage?.content,
    ).toBe('Held answer');

    handleOrchestrationEvent(
      API_BASE,
      event('content.text-delta', { itemId: 'answer', delta: ' final' }),
    );
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage?.content,
    ).toBe('Held answer');
    handleOrchestrationEvent(API_BASE, event('turn.completed'));
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].messages?.at(-1)?.content,
    ).toContain('Held answer final');
  });

  test('disabling mid-turn reveals held text before later immediate text', () => {
    handleOrchestrationEvent(
      API_BASE,
      event('content.text-delta', { itemId: 'answer', delta: 'before' }),
    );
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage,
    ).toBeUndefined();

    const featureSettings = deviceSettingsStore.get('featureSettings');
    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      bufferedDelivery: false,
    });
    handleOrchestrationEvent(
      API_BASE,
      event('content.text-delta', { itemId: 'answer', delta: ' after' }),
    );
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage?.content,
    ).toBe('before after');
  });

  test('closing the owning chat clears held content without recreating it', () => {
    handleOrchestrationEvent(
      API_BASE,
      event('content.text-delta', { itemId: 'answer', delta: 'orphan' }),
    );
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Replacement chat',
    });
    settleSemanticDeliveryBuffer(API_BASE);
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage,
    ).toBeUndefined();
  });

  test('changing the current session drops text held for the previous owner', () => {
    handleOrchestrationEvent(
      API_BASE,
      event('content.text-delta', { itemId: 'answer', delta: 'old owner' }),
    );
    activeChatsStore.updateChat(THREAD_ID, {
      conversationId: 'conversation-replaced',
      currentSessionId: 'replacement-session',
    });
    settleSemanticDeliveryBuffer(API_BASE);
    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage,
    ).toBeUndefined();
  });
});
