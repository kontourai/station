/**
 * The reading half of the outbound-queue external store.
 *
 * `useOutboundQueueSnapshot` is reachable from the entry chunk — the dock
 * chrome that consumes it is eagerly mounted — and the entry ceiling has no
 * headroom, so that module holds only what `useSyncExternalStore` needs
 * synchronously: the cached projection, its listeners, and the two functions
 * React calls. Everything that runs only once something subscribes lives here
 * and is loaded on the first subscription.
 *
 * `outboundDispatch.snapshot()` reconciles accepted terminals before it reads,
 * so it is a durable mutation rather than a pure read; that is why the read
 * happens on a notification and only its result is cached, never inside
 * `getSnapshot`.
 */

import {
  getOutboundQueueSnapshot,
  publishOutboundQueueSnapshot,
} from '../hooks/useOutboundQueueSnapshot';

/**
 * Bumped by every attach and detach. An attach whose dynamic import resolves
 * after its own detach is stale and must not leave a live subscription behind.
 */
let generation = 0;
let detachUpstream: (() => void) | null = null;
/** Serialized so two notifications cannot interleave and publish the older read last. */
let refreshTail: Promise<void> = Promise.resolve();

function refresh(): void {
  refreshTail = refreshTail.then(async () => {
    try {
      const { outboundDispatch } = await import('./outboundQueue');
      publishOutboundQueueSnapshot({
        status: 'ready',
        turns: await outboundDispatch.snapshot(),
      });
    } catch {
      // The last projection actually observed, never an invented empty queue.
      publishOutboundQueueSnapshot({
        status: 'error',
        turns: getOutboundQueueSnapshot().turns,
      });
    }
  });
}

export async function attachOutboundQueueSource(): Promise<void> {
  if (detachUpstream) return;
  const attempt = ++generation;
  const { outboundDispatch } = await import('./outboundQueue');
  if (attempt !== generation) return;
  detachUpstream = outboundDispatch.subscribe(refresh);
  refresh();
}

export function detachOutboundQueueSource(): void {
  generation += 1;
  detachUpstream?.();
  detachUpstream = null;
}

/**
 * Test-only: drop the subscription, the in-flight read chain and the cached
 * projection, so one test's queue cannot leak into the next. The cache reset
 * lives here rather than beside the cache because that module is entry-eager
 * and this one is not.
 */
export function _resetOutboundQueueSource(): void {
  detachOutboundQueueSource();
  refreshTail = Promise.resolve();
  publishOutboundQueueSnapshot({ status: 'pending', turns: [] });
}
