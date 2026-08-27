// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  handleRuntimeErrorEvent,
  handleTurnAbortedEvent,
  handleTurnCompletedEvent,
  handleTurnStartedEvent,
} from '../hooks/orchestration/turnHandlers';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';

describe('OutboundDispatchModule terminal integration', () => {
  let entries: unknown;

  beforeEach(() => {
    entries = undefined;
    _setOutboundQueueStorage({
      getItem: async () => entries,
      setItem: async (_key, next) => {
        entries = next;
      },
      updateItem: async (_key, updater) => {
        entries = updater(entries);
      },
    });
    activeChatsStore.initChat('session-1', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat('session-1');
    _resetOutboundQueueStorage();
  });

  it('removes an accepted head only for its exact provider terminal', async () => {
    await outboundDispatch.enqueue({
      clientTurnId: 'turn-1',
      sessionId: 'session-1',
      agentSlug: 'assistant',
      content: 'turn-1',
    });
    await outboundDispatch.flush(async () => ({
      kind: 'accepted',
      providerTurnId: 'provider-turn-1',
    }));

    handleTurnStartedEvent({
      method: 'turn.started',
      threadId: 'session-1',
      turnId: 'provider-turn-2',
      provider: 'claude',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    // Exact provider identity settles even when the live streaming shell now
    // belongs to a later turn; this is not session-only reconciliation.
    handleTurnCompletedEvent('http://api', {
      method: 'turn.completed',
      threadId: 'session-1',
      turnId: 'provider-turn-1',
      provider: 'claude',
      createdAt: '2026-08-08T00:00:00.000Z',
      outputText: '',
    });
    await vi.waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([]),
    );
  });

  it('does not remove an accepted row without exact provider turn evidence', async () => {
    await outboundDispatch.enqueue({
      clientTurnId: 'receipt-without-provider-turn',
      sessionId: 'session-1',
      agentSlug: 'assistant',
      content: 'turn-1',
    });
    await outboundDispatch.flush(async () => ({
      kind: 'accepted',
      providerTurnId: 'provider-turn-without-terminal',
    }));
    handleTurnStartedEvent({
      method: 'turn.started',
      threadId: 'session-1',
      turnId: 'provider-turn-1',
      provider: 'claude',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    handleTurnCompletedEvent('http://api', {
      method: 'turn.completed',
      threadId: 'session-1',
      turnId: 'provider-turn-1',
      provider: 'claude',
      createdAt: '2026-08-08T00:00:00.000Z',
      outputText: '',
    });
    await vi.waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          clientTurnId: 'receipt-without-provider-turn',
          status: 'accepted',
        }),
      ]),
    );
  });

  it('settles exact aborted and runtime-error terminals without consulting openTurn state', async () => {
    await outboundDispatch.enqueue({
      clientTurnId: 'aborted',
      sessionId: 'session-1',
      agentSlug: 'assistant',
      content: 'aborted',
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'runtime-error',
      sessionId: 'session-2',
      agentSlug: 'assistant',
      content: 'runtime-error',
    });
    await outboundDispatch.flush(async (turn) => ({
      kind: 'accepted',
      providerTurnId:
        turn.clientTurnId === 'aborted'
          ? 'provider-turn-aborted'
          : 'provider-turn-runtime-error',
    }));

    handleTurnAbortedEvent({
      method: 'turn.aborted',
      threadId: 'session-1',
      turnId: 'provider-turn-aborted',
      provider: 'claude',
      reason: 'cancelled',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    handleRuntimeErrorEvent({
      method: 'runtime.error',
      threadId: 'session-2',
      provider: 'claude',
      severity: 'error',
      message: 'failed',
      details: { turnId: 'provider-turn-runtime-error' },
      createdAt: '2026-08-08T00:00:00.000Z',
    });

    await vi.waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([]),
    );
  });
});
