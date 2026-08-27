import { useEffect, useState } from 'react';

/**
 * Keep the initial loading affordance short: a request still pending after
 * this window needs an actionable per-view explanation rather than a forever
 * skeleton. A later successful result always clears the degraded state.
 */
export const DEGRADED_QUERY_TIMEOUT_MS = 8_000;

export type DegradedQueryState = 'loading' | 'degraded' | 'settled';

export function useDegradedQueryState({
  isPending,
  timeoutMs = DEGRADED_QUERY_TIMEOUT_MS,
  resetKey,
}: {
  isPending: boolean;
  timeoutMs?: number;
  /**
   * Bump on retry: a retry that hangs again must get a FRESH loading
   * window before re-degrading, not stay degraded instantly (sol review
   * of #2647, finding 1).
   */
  resetKey?: unknown;
}): DegradedQueryState {
  const [isDegraded, setIsDegraded] = useState(false);

  useEffect(() => {
    // Reading the retry identity is intentional: its value is not otherwise
    // consumed, but a change must restart this effect's loading window.
    void resetKey;
    setIsDegraded(false);
    if (!isPending) return;
    const timeout = window.setTimeout(() => setIsDegraded(true), timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [isPending, timeoutMs, resetKey]);

  if (!isPending) return 'settled';
  return isDegraded ? 'degraded' : 'loading';
}
