import { useState } from 'react';

/** The query-result fields the derivation reads; any `useQuery` result fits. */
export interface RetainableRead {
  data: unknown;
  error: unknown;
  /** When this query entry last failed; survives the reset a refetch makes. */
  errorUpdatedAt: number;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

export interface RetainedReadFailure {
  /** The failure to describe: the current one, or the last one while re-checking. */
  error: unknown;
  /**
   * A re-check is pending: on the wire, or held by TanStack until the network
   * or window focus returns. A Retry tap while it is held only rejoins the
   * held fetch and sends nothing, so callers should show the pending state,
   * not an enabled button that silently does nothing.
   */
  retrying: boolean;
}

/**
 * A failed read that is being retried is still a failed read.
 *
 * TanStack Query resets a query that holds no data back to `pending` — error
 * cleared — at the start of every refetch. A view that branches on
 * `isLoading` before `error` therefore swaps its error card for a skeleton on
 * every background retry (reconnect recovery, an SSE resync, a Retry tap) and
 * back when that retry fails too. Over a dropped connection those retries
 * repeat, and the surface flickered between the two states.
 *
 * This keeps the failure on screen until a refetch answers — including one
 * TanStack paused because the device is offline. Held data wins: a failed
 * refresh of a read that already has data returns `null`, so the view keeps
 * drawing what it has.
 */
export function useRetainedReadFailure(
  query: RetainableRead,
): RetainedReadFailure | null {
  const [last, setLast] = useState<{ error: unknown; at: number } | null>(null);
  // Setting state during render is React's sanctioned way to remember a
  // previous render's value; it re-renders before committing. The time is
  // compared too, so a transport that rejects with one shared error instance
  // still advances the record.
  if (
    query.error != null &&
    (query.error !== last?.error || query.errorUpdatedAt !== last.at)
  ) {
    setLast({ error: query.error, at: query.errorUpdatedAt });
  }
  if (query.data !== undefined) return null;
  const retrying = query.fetchStatus !== 'idle';
  if (query.error != null) return { error: query.error, retrying };
  // Only this entry's own failure is retained: matching the failure time
  // keeps a previous query key's error from describing a different read.
  if (retrying && last && last.at === query.errorUpdatedAt && last.at > 0) {
    return { error: last.error, retrying };
  }
  return null;
}
