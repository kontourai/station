// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOutboundQueueSnapshotCache,
  useOutboundQueueSnapshot,
} from '../hooks/useOutboundQueueSnapshot';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundQueueStorage,
  outboundDispatch,
  type QueuedOutboundTurn,
} from '../lib/outboundQueue';

/**
 * Counts every durable read the queue performs. `updateItem` is the
 * IndexedDB read-modify-write the reconcile pass uses, so it counts too — the
 * claim under test is "the dock stops touching IndexedDB while idle", not
 * "it stops calling one particular method".
 */
function countingStorage(initial?: QueuedOutboundTurn[]) {
  let value: unknown = initial;
  const calls = { durableReads: 0 };
  const storage: OutboundQueueStorage = {
    getItem: async () => {
      calls.durableReads += 1;
      return value;
    },
    setItem: async (_key, next) => {
      value = next;
    },
    updateItem: async (_key, updater) => {
      calls.durableReads += 1;
      value = updater(value);
    },
  };
  return { storage, calls };
}

describe('useOutboundQueueSnapshot', () => {
  beforeEach(() => {
    _resetOutboundQueueSnapshotCache();
  });

  afterEach(() => {
    _resetOutboundQueueSnapshotCache();
    _resetOutboundQueueStorage();
    vi.useRealTimers();
  });

  it('performs no durable read across five seconds of an idle queue', async () => {
    const { storage, calls } = countingStorage();
    _setOutboundQueueStorage(storage);
    // Installed BEFORE the render: a timer the subscription registers on
    // mount has to be a fake one, or advancing time below could not fire it
    // and the assertion would pass against a store that still polls.
    // `shouldAdvanceTime` keeps the module loader's real I/O progressing.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const afterFirstRead = calls.durableReads;
    // The initial subscription really did read once; without this the idle
    // assertion below would also pass on a store that never reads at all.
    expect(afterFirstRead).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(calls.durableReads).toBe(afterFirstRead);
    // Nothing notified, so the cached projection is the same object React
    // compared against — a fresh one per read would re-render forever.
    expect(view.result.current.status).toBe('ready');

    view.unmount();
  });

  it('republishes the projection when the queue changes', async () => {
    const { storage } = countingStorage();
    _setOutboundQueueStorage(storage);

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.turns).toHaveLength(0);
    const idleSnapshot = view.result.current;

    await act(async () => {
      await outboundDispatch.enqueue({
        clientTurnId: 'turn-queued-while-mounted',
        sessionId: 'session-a',
        agentSlug: 'codex',
        conversationId: 'conversation-a',
        content: 'queued offline',
      });
    });

    await waitFor(() =>
      expect(
        view.result.current.turns.map((turn) => turn.clientTurnId),
      ).toEqual(['turn-queued-while-mounted']),
    );
    expect(view.result.current).not.toBe(idleSnapshot);
    expect(
      view.result.current.turns.filter(
        (turn) => turn.conversationId === 'conversation-a',
      ),
    ).toHaveLength(1);

    view.unmount();
  });
});
