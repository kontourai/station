// @vitest-environment jsdom

/**
 * The durable outbound queue is explicitly multi-tab — its write lock is a
 * `navigator.locks` lease precisely because a sibling tab can be mutating the
 * same rows — but `subscribe` is a per-renderer in-memory Set. The one-second
 * poll this branch removed was the ONLY way tab A learned that tab B had
 * enqueued, discarded or drained a turn, so without a cross-tab signal the
 * dock's handoff-disabled guard would stay stale indefinitely.
 *
 * The channel is stubbed rather than real: Node supplies a global
 * `BroadcastChannel` that would deliver across this process, and the property
 * under test is which object hears what, not the platform's plumbing.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOutboundQueueSnapshot } from '../hooks/useOutboundQueueSnapshot';
import {
  _resetOutboundQueueChangeChannel,
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';
import { _resetOutboundQueueSource } from '../lib/outboundQueueSnapshotSource';

type ChannelListener = (event: { data: unknown }) => void;

/**
 * Models the one property this design leans on: a `BroadcastChannel` never
 * delivers a message to the object that posted it. Same-tab transitions
 * therefore arrive only through `subscribe`, and cannot be counted twice.
 */
class FakeBroadcastChannel {
  static live: FakeBroadcastChannel[] = [];
  static closed: FakeBroadcastChannel[] = [];
  readonly listeners = new Set<ChannelListener>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.live.push(this);
  }

  addEventListener(_type: 'message', listener: ChannelListener) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: ChannelListener) {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.live) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data });
    }
  }

  close() {
    FakeBroadcastChannel.closed.push(this);
    FakeBroadcastChannel.live = FakeBroadcastChannel.live.filter(
      (channel) => channel !== this,
    );
  }

  /** Stands in for a sibling tab that already has its own channel open. */
  static anotherTab(name: string) {
    const tab = new FakeBroadcastChannel(name);
    return {
      announceChange() {
        tab.postMessage(name);
      },
      close() {
        tab.close();
      },
    };
  }
}

function countingStorage() {
  let value: unknown;
  const calls = { getItem: 0 };
  const storage: OutboundQueueStorage = {
    getItem: async () => {
      calls.getItem += 1;
      return value;
    },
    setItem: async (_key, next) => {
      value = next;
    },
    updateItem: async (_key, updater) => {
      value = updater(value);
    },
  };
  return {
    storage,
    calls,
    /** Writes the durable row a sibling tab would have written. */
    seedFromAnotherTab(clientTurnId: string) {
      value = {
        version: 2,
        turns: [
          {
            clientTurnId,
            sessionId: 'session-a',
            agentSlug: 'codex',
            conversationId: 'conversation-a',
            content: 'from the other tab',
            createdAt: Date.now(),
            attempts: 0,
            status: 'pending',
          },
        ],
        terminalEvidence: [],
        completedTerminals: [],
      };
    },
  };
}

describe('outbound queue cross-tab convergence', () => {
  beforeEach(() => {
    FakeBroadcastChannel.live = [];
    FakeBroadcastChannel.closed = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    _resetOutboundQueueSource();
    _resetOutboundQueueChangeChannel();
  });

  afterEach(() => {
    _resetOutboundQueueSource();
    _resetOutboundQueueChangeChannel();
    _resetOutboundQueueStorage();
    vi.unstubAllGlobals();
  });

  it('re-reads the queue once when another tab announces a change', async () => {
    const { storage, calls, seedFromAnotherTab } = countingStorage();
    _setOutboundQueueStorage(storage);
    const sibling = FakeBroadcastChannel.anotherTab('station-outbound-queue');

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.turns).toHaveLength(0);
    const readsAfterMount = calls.getItem;
    expect(readsAfterMount).toBeGreaterThan(0);

    seedFromAnotherTab('turn-from-tab-b');
    await act(async () => {
      sibling.announceChange();
    });

    await waitFor(() =>
      expect(
        view.result.current.turns.map((turn) => turn.clientTurnId),
      ).toEqual(['turn-from-tab-b']),
    );
    // One announcement, one durable read — not one per listener and not a
    // retry storm.
    expect(calls.getItem - readsAfterMount).toBe(1);

    view.unmount();
    sibling.close();
  });

  it('does not hear its own announcement twice', async () => {
    const { storage, calls } = countingStorage();
    _setOutboundQueueStorage(storage);

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const readsAfterMount = calls.getItem;

    await act(async () => {
      await outboundDispatch.enqueue({
        clientTurnId: 'turn-from-this-tab',
        sessionId: 'session-a',
        agentSlug: 'codex',
        conversationId: 'conversation-a',
        content: 'local',
      });
    });

    await waitFor(() =>
      expect(
        view.result.current.turns.map((turn) => turn.clientTurnId),
      ).toEqual(['turn-from-this-tab']),
    );
    // `subscribe` carried it. The channel excludes the poster, so the same
    // transition must not also arrive as a remote announcement.
    expect(calls.getItem - readsAfterMount).toBe(1);

    view.unmount();
  });

  it('announces its own change to the other tabs', async () => {
    const { storage } = countingStorage();
    _setOutboundQueueStorage(storage);
    // A sibling tab already listening, exactly as it would be in a second
    // window. Created BEFORE the local mutation, or there would be nothing to
    // deliver to.
    const sibling = new FakeBroadcastChannel('station-outbound-queue');
    const received: unknown[] = [];
    sibling.addEventListener('message', (event) => received.push(event.data));

    await outboundDispatch.enqueue({
      clientTurnId: 'turn-this-tab-enqueued',
      sessionId: 'session-a',
      agentSlug: 'codex',
      conversationId: 'conversation-a',
      content: 'local',
    });

    // Without this the other tab's projection stays stale until it mutates the
    // queue itself — the exact staleness the removed poll used to paper over.
    expect(received).toHaveLength(1);

    sibling.close();
  });

  it('re-reads when a hidden tab becomes visible again', async () => {
    const { storage, calls, seedFromAnotherTab } = countingStorage();
    _setOutboundQueueStorage(storage);

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const readsAfterMount = calls.getItem;

    seedFromAnotherTab('turn-missed-while-hidden');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() =>
      expect(
        view.result.current.turns.map((turn) => turn.clientTurnId),
      ).toEqual(['turn-missed-while-hidden']),
    );
    expect(calls.getItem - readsAfterMount).toBe(1);

    view.unmount();
  });

  it('closes the channel when the last consumer detaches', async () => {
    const { storage } = countingStorage();
    _setOutboundQueueStorage(storage);

    const view = renderHook(() => useOutboundQueueSnapshot());
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(FakeBroadcastChannel.live).toHaveLength(1);

    view.unmount();

    await waitFor(() => expect(FakeBroadcastChannel.live).toHaveLength(0));
    expect(FakeBroadcastChannel.closed).toHaveLength(1);
  });
});
