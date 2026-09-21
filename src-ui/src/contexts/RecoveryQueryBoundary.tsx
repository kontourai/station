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
 *    comes from TWO mechanisms. First, structural key partitioning: recovery
 *    reads that would otherwise use a bare key (`['config']`) go through
 *    `useRecoveryConfig`, whose key carries the explicit origin AND the
 *    live activation identity (`RecoveryScopeContext`: activation key plus
 *    the connect credential generation, which the activation key
 *    deliberately excludes) — a switch or a same-origin credential
 *    rotation NEVER matches a previous entry, so the render commits
 *    pending (never stale) regardless of reset timing or child
 *    layout-effect ordering, and dispatch uses the explicit origin, never
 *    a global getter; the scope ALSO carries the captured SDK request
 *    authority (`RecoveryScope.requestScope`), which leaf reads pass as
 *    `ClientRequestOptions['requestScope']`: the SDK then verifies the
 *    render's capture against the live credential-resolver settlement
 *    before dispatch AND around every owned body read, so a rotation
 *    between render and dispatch (or during a deferred body) fails
 *    closed instead of dispatching under the new credential or decoding
 *    the old body as current. Second, the switch guard below: on
 *    every live-connection tuple change, in-flight reads are cancelled
 *    FIRST (every recovery query threads its AbortSignal) and then every
 *    entry is RESET to its initial state BEFORE PAINT (`useLayoutEffect`),
 *    with mounted reads re-fetching live under the new connection. The
 *    reset destroys no shelf — there is no persister — and covers the
 *    origin-keyed reads (system status, disclosure) whose keys a
 *    same-origin rotation shares.
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
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useHostRequestAuthorityScope } from './ApiBaseContext';

/**
 * The live recovery scope: the explicit origin recovery reads dispatch
 * against, plus the identity that partitions their cache entries. The
 * identity is the request scope's activation key — it advances on every
 * activation (including a return to saved facts that never changed) and on
 * same-origin credential changes — so a switch or rotation NEVER matches a
 * previous entry: the render commits pending, never stale, regardless of
 * reset timing or child layout-effect ordering.
 */
export interface RecoveryScope {
  apiBase: string;
  /**
   * JSON of `[requestScope.authorityKey, connectCredentialGeneration]`.
   * The activation key alone deliberately excludes credential generations
   * (it identifies the endpoint + public epoch only), so same-origin
   * credential rotation would otherwise share the previous entry. The
   * generation count closes that: installing a credential advances the
   * identity even when every saved fact — and the activation epoch — is
   * unchanged.
   */
  identityKey: string;
  /**
   * The captured SDK request authority for dispatch-time and body-decode
   * guards (`ClientRequestOptions['requestScope']`): the origin AND the
   * live activation key the render committed under. Leaf reads pass this
   * to `getJson`/`mutateJson`, which compare it against the credential
   * resolver's live settlement before dispatch AND around every owned
   * body read — a same-origin rotation between render and dispatch, or
   * during a deferred body, fails with `StationRequestAuthorityError`
   * instead of sending A'S credential to B or decoding A's body as B's.
   * Plain data (no `isCurrent` closure): the SDK re-checks liveness
   * itself. `null` when there is no live evidence (no active
   * connection): reads continue unscoped, exactly as before.
   */
  requestScope: { apiBase: string; authorityKey: string } | null;
}

const RecoveryScopeContext = createContext<RecoveryScope | null>(null);

/**
 * Fail-closed: recovery-scoped reads must never run outside the boundary
 * that partitions them. Consumers render recovery UI; without the boundary
 * there is no identity to scope by.
 */
export function useRecoveryScope(): RecoveryScope {
  const scope = useContext(RecoveryScopeContext);
  if (!scope) {
    throw new Error(
      'useRecoveryScope must be used within RecoveryQueryBoundary',
    );
  }
  return scope;
}

/**
 * The recovery scope when the caller renders inside the stable recovery
 * shell, `null` in the protected tree. Shared components owned by BOTH
 * trees (`UsageTelemetryDisclosure`: the recovery gate's first-run modal
 * AND the protected Settings section / first-run chapter) must use this:
 * the recovery shell reads its captured scope while protected consumers
 * retain the protected client/context path. Throwing here would make the
 * shared component unmountable in the tree that owns most of its
 * surfaces.
 */
export function useOptionalRecoveryScope(): RecoveryScope | null {
  return useContext(RecoveryScopeContext);
}

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

  // The identity partitioning recovery reads. A stable memo (not the raw
  // scope object, whose identity is not an authority change): subscribers
  // re-render only when the facts change.
  const identityKey = JSON.stringify([
    requestScope?.authorityKey ?? null,
    connectionId ? credentialAuthorityGeneration(connectionId) : 0,
  ]);
  // Plain-data snapshot of the captured request authority for the
  // dispatch/body guards (see `RecoveryScope.requestScope`). Derived
  // inside the same memo so subscribers re-render only when the facts
  // change; the SDK's live `isCurrent` is consulted per request, never
  // captured here.
  const requestScopeApiBase = requestScope?.apiBase ?? null;
  const requestScopeAuthorityKey = requestScope?.authorityKey ?? null;
  const scopeValue = useMemo(
    () => ({
      apiBase,
      identityKey,
      requestScope:
        requestScopeApiBase && requestScopeAuthorityKey
          ? {
              apiBase: requestScopeApiBase,
              authorityKey: requestScopeAuthorityKey,
            }
          : null,
    }),
    [apiBase, identityKey, requestScopeApiBase, requestScopeAuthorityKey],
  );

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
    // NOTE: protected toasts/actions are NOT re-scoped here. The toast
    // store is a module singleton with no unmount clearing at baseline;
    // a connection-only ambient dismissal here would miss same-origin
    // authority changes and mis-stamp late callbacks from the retired
    // authority as current. Full toast/notification/action isolation is a
    // separate #481/106 follow-up; this slice preserves baseline behavior.
  }, [client, switchTuple]);

  return (
    <QueryClientProvider client={client}>
      <RecoveryScopeContext.Provider value={scopeValue}>
        {children}
      </RecoveryScopeContext.Provider>
    </QueryClientProvider>
  );
}
