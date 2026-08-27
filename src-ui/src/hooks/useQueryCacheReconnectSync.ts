/**
 * station#1223 (offline slice 1) — reconnect invalidation.
 *
 * Cache-first persistence (`../lib/queryPersistence.ts`) shows the
 * last-loaded data instantly, including data restored from a previous
 * session's IndexedDB cache. That data must be treated as stale the moment
 * the server is confirmed reachable again, so this invalidates the
 * whitelisted persisted queries on every transition into `'connected'` —
 * both the ordinary offline→online reconnect and the very first successful
 * connect after a cold boot (when the restored cache can be arbitrarily old).
 *
 * station#3069 extends the same transition to drive recovery for queries that
 * ERRORED during the outage, whatever their key — see the comment on the
 * `refetchQueries` call below for why nothing else in the client can.
 *
 * Reuses the existing connection-health signal (`useConnectionStatus`,
 * already globally mounted via `ConnectionBannerSource`) rather than building a new
 * offline detector — this is an additional subscriber to the same shared
 * per-connection coordinator, not a second poller.
 */
import { useConnectionStatus } from '@kontourai/station-connect';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { invalidatePersistedQueries } from '../lib/queryPersistence';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';

export function useQueryCacheReconnectSync(): void {
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const queryClient = useQueryClient();
  const previousStatusRef = useRef(status);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    if (previousStatus !== 'connected' && status === 'connected') {
      void invalidatePersistedQueries(queryClient);
      // station#3069 — recover queries that FAILED during the outage, whatever
      // their key. `invalidatePersistedQueries` above only covers
      // `PERSISTED_QUERY_KEY_PREFIXES`, so every deliberately-unpersisted key
      // ('orchestration-*', 'attention', 'tasks', 'acp-connections', …) that
      // errored while the server was unreachable had NO path back to a refetch:
      //   - `refetchOnMount: false` and `refetchOnWindowFocus: false` (both set
      //     in `main.tsx`) rule out the two automatic paths a default client has;
      //   - `retry: 1` is long exhausted by the time the outage ends;
      //   - react-query's own `refetchOnReconnect` rides `onlineManager`, which
      //     listens to the window `online` event — and that event NEVER FIRES for
      //     the outage shape this app actually sees. Measured on-device
      //     (Pixel, debug build, CDP): dropping and restoring the Tailscale VPN
      //     leaves `navigator.onLine === true` throughout and emits zero
      //     online/offline events, because the Wi-Fi link never went down. Only
      //     the route did.
      // The user-visible result was a stale error card (Home's "Recent work
      // unavailable", backed by the unpersisted `orchestration-sessions` key)
      // that survived reconnection and could only be cleared by restarting the
      // app — reproduced on-device before this fix.
      //
      // Scoped to `status === 'error'` on purpose: this is recovery, not a
      // blanket refresh. Queries holding good data are left alone (no
      // thundering herd on every reconnect); only the ones with nothing to show
      // are re-driven, which is exactly what the outage broke.
      void queryClient.refetchQueries({
        predicate: (query) => query.state.status === 'error',
      });
    }
  }, [status, queryClient]);
}
