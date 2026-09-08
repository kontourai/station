/**
 * The durable outbound queue projected as a React external store.
 *
 * `outboundDispatch` already publishes every durable transition through
 * `subscribe`, so a consumer that wants the current queue does not need to
 * poll IndexedDB — it needs to read a cached projection and be told when that
 * projection changed. This module is the cache and nothing else.
 *
 * It is reachable from the entry chunk (the dock chrome that consumes it is
 * eagerly mounted), so it holds only what `useSyncExternalStore` needs
 * synchronously. The reading half — the subscription, the IndexedDB read and
 * its serialization — is `lib/outboundQueueSnapshotSource`, loaded on the
 * first subscription.
 *
 * `getSnapshot` must return a referentially stable value between
 * notifications or React re-renders forever, so the cached object is replaced
 * only when a read settles, never minted per call.
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

const PENDING: OutboundQueueSnapshot = { status: 'pending', turns: [] };

let cached: OutboundQueueSnapshot = PENDING;
const listeners = new Set<() => void>();

const source = () => import('../lib/outboundQueueSnapshotSource');

/** Called by the source once a read settles. */
export function publishOutboundQueueSnapshot(
  next: OutboundQueueSnapshot,
): void {
  cached = next;
  for (const listener of listeners) listener();
}

export function getOutboundQueueSnapshot(): OutboundQueueSnapshot {
  return cached;
}

export function subscribeOutboundQueueSnapshot(
  listener: () => void,
): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void source().then((module) => module.attachOutboundQueueSource());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      void source().then((module) => module.detachOutboundQueueSource());
    }
  };
}

export function useOutboundQueueSnapshot(): OutboundQueueSnapshot {
  return useSyncExternalStore(
    subscribeOutboundQueueSnapshot,
    getOutboundQueueSnapshot,
    getOutboundQueueSnapshot,
  );
}
