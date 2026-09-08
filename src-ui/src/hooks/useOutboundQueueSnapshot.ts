/**
 * The durable outbound queue projected as a React external store.
 *
 * `outboundDispatch` already publishes every durable transition through
 * `subscribe`, so a consumer that wants the current queue does not need to
 * poll IndexedDB — it needs to read a cached projection and be told when that
 * projection changed. This module is that cache.
 *
 * Two constraints shape it:
 *
 * - `outboundDispatch.snapshot()` is asynchronous AND it reconciles accepted
 *   terminals before it reads, so it is a durable mutation, not a pure read.
 *   `useSyncExternalStore`'s `getSnapshot` must be synchronous and free of
 *   side effects, so the read happens in the subscription listener and only
 *   its result is cached here.
 * - `getSnapshot` must return a referentially stable value between
 *   notifications or React re-renders forever, so the cached object is
 *   replaced only when a read settles — never minted per call.
 *
 * The module keeps `lib/outboundQueue` behind a dynamic import for the same
 * reason every other caller does: the eagerly mounted dock chrome must not
 * charge first paint for the IndexedDB dispatch machinery.
 */

import { useSyncExternalStore } from 'react';
import type { OutboundDispatchTurn } from '../lib/outboundQueue';

export interface OutboundQueueSnapshot {
  /**
   * `pending` until the first read settles — the consumer cannot yet claim
   * the queue is empty. `error` means the read failed and `turns` is the last
   * value that was actually observed, never an invented empty queue.
   */
  status: 'pending' | 'ready' | 'error';
  turns: readonly OutboundDispatchTurn[];
}

const PENDING: OutboundQueueSnapshot = Object.freeze({
  status: 'pending' as const,
  turns: Object.freeze([]) as readonly OutboundDispatchTurn[],
});

let cached: OutboundQueueSnapshot = PENDING;
const listeners = new Set<() => void>();
let detachUpstream: (() => void) | null = null;
let refreshTail: Promise<void> = Promise.resolve();

function publish(next: OutboundQueueSnapshot): void {
  cached = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A throwing consumer must not starve the others.
    }
  }
}

/**
 * Serialized so overlapping notifications cannot interleave two reads and
 * publish the older one last.
 */
function refresh(): void {
  refreshTail = refreshTail.then(async () => {
    try {
      const { outboundDispatch } = await import('../lib/outboundQueue');
      publish({ status: 'ready', turns: await outboundDispatch.snapshot() });
    } catch {
      if (cached.status === 'error') return;
      publish({ status: 'error', turns: cached.turns });
    }
  });
}

export function subscribeOutboundQueueSnapshot(
  listener: () => void,
): () => void {
  listeners.add(listener);
  if (!detachUpstream) {
    let disposed = false;
    let inner: (() => void) | null = null;
    void import('../lib/outboundQueue').then(({ outboundDispatch }) => {
      if (disposed) return;
      inner = outboundDispatch.subscribe(refresh);
    });
    detachUpstream = () => {
      disposed = true;
      inner?.();
      inner = null;
    };
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachUpstream?.();
      detachUpstream = null;
    }
  };
}

export function getOutboundQueueSnapshot(): OutboundQueueSnapshot {
  return cached;
}

export function useOutboundQueueSnapshot(): OutboundQueueSnapshot {
  return useSyncExternalStore(
    subscribeOutboundQueueSnapshot,
    getOutboundQueueSnapshot,
    getOutboundQueueSnapshot,
  );
}

/** Test-only: drop the cache so one test's queue cannot leak into the next. */
export function _resetOutboundQueueSnapshotCache(): void {
  cached = PENDING;
  listeners.clear();
  detachUpstream?.();
  detachUpstream = null;
  refreshTail = Promise.resolve();
}
