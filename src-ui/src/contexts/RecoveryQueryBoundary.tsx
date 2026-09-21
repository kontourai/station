/**
 * Stable recovery query lifetime for connection selection/pairing/recovery
 * UI. Mounted ABOVE `AuthorityQueryProvider` (`main.tsx`), so an authority
 * activation transition — which replaces the ENTIRE protected subtree with a
 * loading skeleton plus a fresh per-namespace persisted client — never
 * unmounts the open `ConnectionManagerModal` mid-flow (hosted #481
 * regression: adding an address activated it, the pending observation
 * unmounted the modal, Request Access/Back disappeared).
 *
 * What this boundary is and is not:
 *  - It owns a FRESH nonpersisted `QueryClient` per mount: no persister
 *    subscription (nothing is saved under an unverified identity) and no
 *    restore (no remembered shelf is ever hydrated without a live
 *    observation). Recovery reads (`['system-status', apiBase]`,
 *    `['config']`, `['usage-telemetry-disclosure', apiBase]`) fetch live or
 *    fail honestly. Nothing protected ever reads through the observation
 *    bootstrap client, and nothing here touches it either.
 *  - The client instance is STABLE across activation transitions — that is
 *    the point; remounting it would remount the modal and reintroduce the
 *    defect. Cross-authority quarantine therefore cannot come from a fresh
 *    client per context (the `EphemeralTree` mechanism one layer down). It
 *    comes from the switch guard below instead: on every live-connection
 *    tuple change, in-flight reads are cancelled FIRST (every recovery
 *    query threads its AbortSignal) and then every entry is RESET to its
 *    initial state BEFORE PAINT (`useLayoutEffect`), with mounted reads
 *    re-fetching live under the new connection. The reset destroys no
 *    shelf — there is no persister — and plain invalidation would be
 *    insufficient for the bare `['config']` key, which carries no endpoint
 *    segment and would otherwise serve the previous home (stale paint)
 *    until its refetch resolved.
 *  - Protected cache invalidation on switch does NOT live here. It lives in
 *    the authority tree (`AuthoritySwitchInvalidator`), where the persisted
 *    per-namespace client and the persister's restoring gate are in scope.
 *    Invalidating from here would hit the wrong client.
 *
 * Residual (stated, not covered): the drop runs before paint, but a render
 * that commits in the same frame as the switch can still compute from the
 * outgoing entry without painting it. Recovery reads are limited to
 * health/readiness/config/disclosure — no project/agent/conversation rows —
 * and nothing written here reaches any persisted shelf.
 */

import { useConnections } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from './ApiBaseContext';

function createRecoveryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: 1,
      },
    },
  });
}

export function RecoveryQueryBoundary({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const { apiBase, activeConnection, credentialAuthorityGeneration } =
    useConnections();
  const requestScope = useHostRequestAuthorityScope();
  const [client] = useState(() => createRecoveryClient());

  const connectionId = activeConnection?.id ?? null;
  // The same liveness tuple the authority tree keys its ephemeral
  // fallbacks on, plus the live activation scope: a return to a row whose
  // saved facts never changed still advances the activation epoch, so the
  // return trip drops the cache instead of serving the previous visit.
  const switchTuple = JSON.stringify([
    apiBase,
    connectionId,
    connectionId ? credentialAuthorityGeneration(connectionId) : 0,
    activeConnection?.credentialState ?? null,
    requestScope?.authorityKey ?? null,
  ]);

  const previousTupleRef = useRef(switchTuple);
  useLayoutEffect(() => {
    if (previousTupleRef.current === switchTuple) return;
    previousTupleRef.current = switchTuple;
    // Retirement discipline, mirrored from the authority tree: cancel
    // signal-abiding in-flight reads first, then RESET every entry to its
    // initial state and refetch the mounted ones. `removeQueries` alone is
    // insufficient here — a removed query's mounted observer keeps serving
    // the detached entry with no refetch (proven by the bare-key test), so
    // the previous connection's reads would linger under the new one.
    // `resetQueries` drops to pending immediately (no stale paint) and
    // re-reads live under the new connection. This client has NO persister
    // and restores NOTHING, so the reset destroys no shelf.
    void client.cancelQueries();
    void client.resetQueries();
  }, [client, switchTuple]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
