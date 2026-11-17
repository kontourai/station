// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Observations = typeof import('../lib/outboundAcceptedTurnObservations');

describe('the snapshot-to-outbox hand-off', () => {
  let observations: Observations;

  beforeEach(async () => {
    vi.resetModules();
    observations = await import('../lib/outboundAcceptedTurnObservations');
  });

  afterEach(() => {
    vi.resetModules();
  });

  const observation = (conversationId: string, observedAt: number) => ({
    records: [{ conversationId }],
    observedAt,
  });

  it('keeps what was observed before the outbox loaded and hands it over in order', () => {
    observations.observeConversationOpenTurns(observation('first', 1));
    observations.observeConversationOpenTurns(observation('second', 2));
    const settler = vi.fn();

    observations.registerAcceptedTurnSettler(settler);

    expect(settler.mock.calls.map(([seen]) => seen.observedAt)).toEqual([1, 2]);
    // Handed over once: a later observation does not replay the earlier ones.
    observations.observeConversationOpenTurns(observation('third', 3));
    expect(settler.mock.calls.map(([seen]) => seen.observedAt)).toEqual([
      1, 2, 3,
    ]);
  });

  it('keeps a bounded number while it waits, dropping the oldest', () => {
    for (let at = 1; at <= 20; at += 1)
      observations.observeConversationOpenTurns(observation(`c-${at}`, at));
    const settler = vi.fn();

    observations.registerAcceptedTurnSettler(settler);

    expect(settler).toHaveBeenCalledTimes(16);
    expect(settler.mock.calls[0]?.[0].observedAt).toBe(5);
    expect(settler.mock.calls.at(-1)?.[0].observedAt).toBe(20);
  });

  it('publishes nothing for a snapshot that named no conversation record', () => {
    const settler = vi.fn();
    observations.registerAcceptedTurnSettler(settler);

    observations.observeConversationOpenTurns({ records: [], observedAt: 1 });

    expect(settler).not.toHaveBeenCalled();
  });

  it('a snapshot hands its records over before applyOrchestrationSnapshot returns', async () => {
    const settler = vi.fn();
    observations.registerAcceptedTurnSettler(settler);
    const { applyOrchestrationSnapshot } = await import(
      '../hooks/orchestration/snapshotHandlers'
    );

    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId: 'conversation-1',
          status: 'ready',
          hasActiveTurn: true,
          conversationActivity: {
            conversationId: 'conversation-1',
            asOfSequence: 40,
            openTurn: {
              threadId: 'conversation-1',
              turnId: 'provider-turn-9',
              startedAt: '2026-08-08T00:00:00.000Z',
            },
          },
        },
      ],
    });

    // Synchronously: nothing is left running for a later test or a later tick.
    expect(settler).toHaveBeenCalledTimes(1);
    expect(settler.mock.calls[0]?.[0].records).toEqual([
      { conversationId: 'conversation-1', openTurnId: 'provider-turn-9' },
    ]);
  });
});
