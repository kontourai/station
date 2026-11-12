// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { applyOrchestrationSnapshot } from '../hooks/orchestration/snapshotHandlers';
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

  describe('an accepted row whose terminal this browser never saw', () => {
    /** A turn of time, so an acceptance is recorded before what follows it. */
    const later = () => new Promise((resolve) => setTimeout(resolve, 5));

    async function acceptedRow(
      providerTurnId: string,
      sessionId = 'session-1',
    ) {
      await outboundDispatch.enqueue({
        clientTurnId: `key-${providerTurnId}`,
        sessionId,
        agentSlug: 'assistant',
        content: 'replayed on reconnect',
      });
      await outboundDispatch.flush(async () => ({
        kind: 'accepted',
        providerTurnId,
      }));
      await later();
    }

    /** The connect-time snapshot row for a conversation and its open turn. */
    function snapshotOf(
      conversationId: string,
      openTurnId?: string,
      record = true,
    ): Parameters<typeof applyOrchestrationSnapshot>[0] {
      return {
        sessions: [
          {
            provider: 'claude',
            threadId: conversationId,
            status: 'ready',
            hasActiveTurn: openTurnId !== undefined,
            ...(record
              ? {
                  conversationActivity: {
                    conversationId,
                    asOfSequence: 40,
                    ...(openTurnId
                      ? {
                          openTurn: {
                            threadId: conversationId,
                            turnId: openTurnId,
                            startedAt: '2026-08-08T00:00:00.000Z',
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        ],
      };
    }

    it.each([
      ['no open turn', undefined],
      ['another open turn', 'provider-turn-later'],
    ])(
      'lets it go when the server snapshot names %s for its conversation',
      async (_case, openTurnId) => {
        await acceptedRow('provider-turn-missed');
        // The page was away while the turn ran: no terminal event arrives,
        // only the snapshot every fresh connection begins with.
        applyOrchestrationSnapshot(snapshotOf('session-1', openTurnId), {
          apiBase: 'http://api',
        });
        await vi.waitFor(async () =>
          expect(await outboundDispatch.snapshot()).toEqual([]),
        );
        // The turn's own terminal, replayed late, finds nothing to settle and
        // leaves no evidence behind for a later row.
        handleTurnCompletedEvent('http://api', {
          method: 'turn.completed',
          threadId: 'session-1',
          turnId: 'provider-turn-missed',
          provider: 'claude',
          createdAt: '2026-08-08T00:00:00.000Z',
          outputText: '',
        });
        await later();
        await outboundDispatch.snapshot();
        expect(
          (entries as { terminalEvidence: unknown[] }).terminalEvidence,
        ).toEqual([]);
      },
    );

    it('keeps it while the snapshot names its turn as the open one', async () => {
      await acceptedRow('provider-turn-running');
      applyOrchestrationSnapshot(
        snapshotOf('session-1', 'provider-turn-running'),
        { apiBase: 'http://api' },
      );
      await later();
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          status: 'accepted',
          providerTurnId: 'provider-turn-running',
        }),
      ]);
    });

    it('keeps it when the snapshot carries no conversation record, or one for another conversation', async () => {
      await acceptedRow('provider-turn-unknown');
      applyOrchestrationSnapshot(snapshotOf('session-1', undefined, false), {
        apiBase: 'http://api',
      });
      applyOrchestrationSnapshot(snapshotOf('session-2'), {
        apiBase: 'http://api',
      });
      await later();
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({ status: 'accepted' }),
      ]);
    });

    it('keeps a row accepted after the record was read, and every row that is not accepted', async () => {
      const readAt = Date.now();
      await later();
      await acceptedRow('provider-turn-newer');
      await outboundDispatch.enqueue({
        clientTurnId: 'still-waiting',
        sessionId: 'session-1',
        agentSlug: 'assistant',
        content: 'behind it',
      });
      await outboundDispatch.completeAcceptedTurnsNotOpen(
        [{ conversationId: 'session-1' }],
        readAt,
      );
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({ status: 'accepted' }),
        expect.objectContaining({ status: 'pending' }),
      ]);
      // A record read after the acceptance settles the accepted row only.
      await outboundDispatch.completeAcceptedTurnsNotOpen(
        [{ conversationId: 'session-1' }],
        Date.now(),
      );
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          clientTurnId: 'still-waiting',
          status: 'pending',
        }),
      ]);
    });
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
