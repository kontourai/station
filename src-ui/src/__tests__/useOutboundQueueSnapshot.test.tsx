// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOutboundQueueSnapshot } from '../hooks/useOutboundQueueSnapshot';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundQueueStorage,
  outboundDispatch,
  type QueuedOutboundTurn,
} from '../lib/outboundQueue';
import {
  _resetOutboundQueueSource,
  attachOutboundQueueSource,
  detachOutboundQueueSource,
} from '../lib/outboundQueueSnapshotSource';

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
    _resetOutboundQueueSource();
  });

  afterEach(() => {
    _resetOutboundQueueSource();
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

  it('opens nothing at all while the consumer is disabled', async () => {
    const { storage, calls } = countingStorage();
    _setOutboundQueueStorage(storage);
    const subscribe = vi.spyOn(outboundDispatch, 'subscribe');

    const view = renderHook(() => useOutboundQueueSnapshot(false));
    await act(async () => {
      await Promise.resolve();
    });

    // A dock with no conversation has nothing to gate on, so it must not
    // charge the boot with opening IndexedDB.
    expect(view.result.current.status).toBe('pending');
    expect(calls.durableReads).toBe(0);
    expect(subscribe).not.toHaveBeenCalled();

    subscribe.mockRestore();
    view.unmount();
  });

  /**
   * `attach` reaches the queue through a dynamic import, so a consumer that
   * mounts and unmounts inside that window would otherwise leave a live
   * subscription (and a durable read) behind for a store nobody is watching.
   * Driven against the source directly because the race IS the gap between
   * `attach` starting and its import resolving.
   */
  it('abandons an attach whose consumer left before the queue module loaded', async () => {
    const { storage, calls } = countingStorage();
    _setOutboundQueueStorage(storage);
    const subscribe = vi.spyOn(outboundDispatch, 'subscribe');

    const attaching = attachOutboundQueueSource();
    detachOutboundQueueSource();
    await attaching;
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribe).not.toHaveBeenCalled();
    expect(calls.durableReads).toBe(0);

    subscribe.mockRestore();
  });
});
