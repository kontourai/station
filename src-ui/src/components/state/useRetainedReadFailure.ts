import { useState } from 'react';

/** The query-result fields the derivation reads; any `useQuery` result fits. */
export interface RetainableRead {
  data: unknown;
  error: unknown;
  errorUpdateCount: number;
  isFetching: boolean;
}

export interface RetainedReadFailure {
  /** The failure to describe: the current one, or the last one while retrying. */
  error: unknown;
  /** A refetch is in flight; the failure stands until it answers. */
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
 * This keeps the failure on screen, marked `retrying`, until a refetch
 * answers. Held data wins: a failed refresh of a read that already has data
 * returns `null`, so the view keeps drawing what it has.
 */
export function useRetainedReadFailure(
  query: RetainableRead,
): RetainedReadFailure | null {
  const [lastError, setLastError] = useState<unknown>(null);
  // Setting state during render is React's sanctioned way to remember a
  // previous render's value; it re-renders before committing.
  if (query.error != null && query.error !== lastError) {
    setLastError(query.error);
  }
  if (query.data !== undefined) return null;
  if (query.error != null) {
    return { error: query.error, retrying: query.isFetching };
  }
  // `errorUpdateCount` belongs to the query entry, so a new key that never
  // failed does not inherit a previous key's failure.
  if (query.errorUpdateCount > 0 && query.isFetching && lastError != null) {
    return { error: lastError, retrying: true };
  }
  return null;
}
