import type { DefaultOptions } from '@tanstack/react-query';

/**
 * station#2327 — the desktop native broker refuses a read with this code when
 * its per-Station request queue is already full. Retrying that read only adds
 * another entry to the queue that just refused it, so a stalled Station's
 * backlog grows with every poll instead of draining. Keyed on the stable FFI
 * `code` (`src-desktop/src/lib.rs`, `native_http_capacity_refusal`), never on
 * the message text, which Rust may reword.
 */
const SATURATED_TRANSPORT_CODE = 'transport_capacity';

function isSaturatedTransportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === SATURATED_TRANSPORT_CODE
  );
}

/**
 * `retry: 1` semantics — one retry after the first failure — except for a
 * saturated transport, which is not retried at all.
 */
export function stationDefaultQueryRetry(
  failureCount: number,
  error: unknown,
): boolean {
  return failureCount < 1 && !isSaturatedTransportError(error);
}

/**
 * The query defaults shared by every app-owned QueryClient: the bootstrap
 * observation client (`main.tsx`), each per-authority client
 * (`AuthorityQueryContext.tsx`) and the recovery client
 * (`RecoveryQueryBoundary.tsx`). One definition, so the three cannot drift
 * apart on how hard they lean on a failing Station.
 */
export function stationQueryDefaults(): NonNullable<DefaultOptions['queries']> {
  return {
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes (renamed from cacheTime in v5)
    refetchOnWindowFocus: false,
    // Prevent StrictMode double-fetch — if data is in cache, don't refetch on mount
    refetchOnMount: false,
    retry: stationDefaultQueryRetry,
  };
}
