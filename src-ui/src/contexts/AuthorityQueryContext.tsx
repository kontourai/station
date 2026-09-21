/**
 * #481 client authority — observation-gated, per-authority query isolation.
 *
 * Replaces the single global persisted `QueryClient` with one `QueryClient`
 * per VERIFIED authority namespace (see `lib/authorityNamespace.ts`):
 *
 *  - A minimal NONPERSISTED bootstrap client (owned by `main.tsx`, above
 *    this provider) carries exactly one query: the credential-bound
 *    authority observation (`GET /api/auth/authority`). Nothing protected
 *    ever reads through it.
 *  - The observation is fetched with the RENDER-captured request scope and
 *    rejected synchronously when stale: the scope is passed through to
 *    `getAuthorityObservation`, so the SDK's `bindRequestAuthority` refuses
 *    dispatch against a replaced authority and `guardResponseAuthority`
 *    refuses a late body read; a post-await `isCurrent()` check covers the
 *    remainder. A delayed A response can therefore never activate on B —
 *    the namespace commits only from the CURRENT key's data.
 *  - Re-observation is keyed on the live credential facts (`apiBase`,
 *    connection id, credential authority generation, credential state), so
 *    credential transitions and auth/reconnect changes re-verify. The
 *    principal itself is always closed server fact, never cookie contents,
 *    endpoint text, or a profile label.
 *  - Each verified namespace gets a FRESH `QueryClient` under its own
 *    `PersistQueryClientProvider` with a disjoint IndexedDB key, so two
 *    homes sharing project ids (or one endpoint serving two principals)
 *    can never collide. Switching namespaces retires the old client with
 *    `cancelQueries()` + `unmount()` BEFORE the new tree mounts — see the
 *    `_getApiBase` audit below.
 *  - No observation (old server, offline, unpaired) is explicit
 *    unavailable/unverified persistence, never guessed identity: the last
 *    verified namespace's blob may be RESTORED for reading (status
 *    'unverified') but is never treated as current authorization; with no
 *    remembered namespace the tree runs ephemeral (status 'unavailable') so
 *    first-pairing repair stays usable.
 *
 * `_getApiBase` AUDIT (the seam a per-context client alone does not close):
 * legacy SDK query-domain fetchers resolve the module-global origin AT
 * FETCH TIME (`await _getApiBase()` inside the queryFn). A delayed legacy
 * fetcher from a retired client could therefore issue against the NEW
 * global origin after a switch. Integrated guards, in order:
 *   1. Retirement cancels: `cancelQueries()` on the old client clears
 *      scheduled retries/refetch timers and aborts signal-abiding in-flight
 *      fetches (every `useApiQuery` fetch receives its AbortSignal).
 *   2. `unmount()` detaches the retired cache so late resolutions have no
 *      live observers to notify and no persister still subscribed.
 *   3. Scoped fetchers (Project read/reorder, search, and every fetcher
 *      that threads `requestScope`) additionally throw
 *      `StationRequestAuthorityError` at dispatch AND at body-read time when
 *      their captured scope no longer matches the live authority.
 *   4. The boot-payload seed below — the one remaining client `_getApiBase`
 *      consumer — seeds ONLY when its captured scope is still current.
 * Residual: an unscoped fetcher that ignores its AbortSignal and already
 * resolved the global origin post-switch could still dispatch one request
 * under the new origin with the live credential. That request authenticates
 * (it carries current authority) but its result lands in a retired,
 * unmounted cache and is discarded — it cannot poison the new authority's
 * cache, which lives in a different client. Cache clears do not cancel
 * dispatched mutations, and root contexts/drafts/queued turns/deep links
 * remain independent later exits — this slice claims query partition only,
 * never full #481.
 */

import { useConnections } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '@kontourai/station-sdk/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  type AsyncStorage,
  PersistQueryClientProvider,
  persistQueryClientRestore,
} from '@tanstack/react-query-persist-client';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SkeletonBlock } from '../components/state';
import {
  type AuthorityPersistenceStatus,
  authorityPersistenceKey,
  buildAuthorityNamespace,
} from '../lib/authorityNamespace';
import { resolveLocalUiSession } from '../lib/local-ui-bootstrap';
import {
  applyPersistedQueryGcTimeDefaults,
  buildPersistOptions,
} from '../lib/queryPersistence';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { useHostRequestAuthorityScope } from './ApiBaseContext';

export interface AuthorityObservationRequest {
  apiBase: string;
  requestScope: ApiRequestScope | undefined;
  signal: AbortSignal;
}

/** Injectable wire seam: production reads the live endpoint, tests inject deferreds. */
export type FetchAuthorityObservation = (
  request: AuthorityObservationRequest,
) => Promise<AuthorityObservation>;

const defaultFetchAuthorityObservation: FetchAuthorityObservation = ({
  apiBase,
  requestScope,
  signal,
}) =>
  getAuthorityObservation(apiBase, {
    ...(requestScope ? { requestScope } : {}),
    signal,
  });

interface AuthorityPersistenceContextValue {
  status: AuthorityPersistenceStatus;
  /** Active durable namespace, or the remembered one while unverified. */
  namespace: string | null;
  observation: AuthorityObservation | null;
}

const AuthorityPersistenceContext =
  createContext<AuthorityPersistenceContextValue>({
    status: 'unavailable',
    namespace: null,
    observation: null,
  });

export function useAuthorityPersistence(): AuthorityPersistenceContextValue {
  return useContext(AuthorityPersistenceContext);
}

/** Non-secret record of the last verified namespace, for offline restore. */
const LAST_VERIFIED_NAMESPACE_KEY = 'station-authority-last-verified';

function readLastVerifiedNamespace(): string | null {
  try {
    return localStorage.getItem(LAST_VERIFIED_NAMESPACE_KEY);
  } catch {
    return null;
  }
}

function writeLastVerifiedNamespace(namespace: string): void {
  try {
    localStorage.setItem(LAST_VERIFIED_NAMESPACE_KEY, namespace);
  } catch {
    // Persistence of the pointer is best-effort; the IDB blobs are intact.
  }
}

/** A 401 from the observation read: the credential is not authorized. */
function isUnauthorizedObservationFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /did not accept the presented credential/.test(error.message)
  );
}

interface ActiveAuthorityClient {
  namespace: string;
  queryClient: QueryClient;
}

function createAuthorityClient(): QueryClient {
  const queryClient = new QueryClient({
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
  applyPersistedQueryGcTimeDefaults(queryClient);
  return queryClient;
}

/**
 * Retire a replaced authority's client: stop its timers/retries FIRST so no
 * legacy `_getApiBase` fetcher it owns can launch against the new global
 * origin, then detach its cache. See the module audit above.
 */
export function retireAuthorityClient(queryClient: QueryClient): void {
  void queryClient.cancelQueries();
  queryClient.unmount();
}

export function AuthorityQueryProvider({
  children,
  fetchObservation = defaultFetchAuthorityObservation,
  storage,
  localUiApiBase,
  persistThrottleTimeMs,
}: {
  children: ReactNode;
  fetchObservation?: FetchAuthorityObservation;
  /** Injected `AsyncStorage` for tests; production uses IndexedDB. */
  storage?: AsyncStorage<string>;
  /** Same-origin API base for the boot-payload seed (`main.tsx`). */
  localUiApiBase: string;
  /** Persister coalescing window; production default (1000ms) when omitted. */
  persistThrottleTimeMs?: number;
}): ReactNode {
  const { apiBase, activeConnection, credentialAuthorityGeneration } =
    useConnections();
  const requestScope = useHostRequestAuthorityScope();
  const profile = usePlatformProfile();

  const connectionId = activeConnection?.id ?? null;
  const credentialState = activeConnection?.credentialState ?? null;
  const authorityGeneration = connectionId
    ? credentialAuthorityGeneration(connectionId)
    : 0;

  const observationEnabled =
    activeConnection !== null && requestScope !== undefined;
  const observationKey = observationEnabled
    ? [
        'authority-observation',
        apiBase,
        connectionId,
        authorityGeneration,
        credentialState,
      ]
    : null;

  // The scope this key's fetch is bound to, snapshotted from the render that
  // owns the key. A switch replaces BOTH together, so a queryFn closure can
  // never pair a new scope with an old key or vice versa.
  const boundScope = observationEnabled ? requestScope : undefined;
  const boundApiBase = apiBase;

  const observationQuery = useQuery({
    queryKey: observationKey ?? ['authority-observation', 'disabled'],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!boundScope) throw new StationRequestAuthorityError();
      const observation = await fetchObservation({
        apiBase: boundApiBase,
        requestScope: {
          apiBase: boundScope.apiBase,
          authorityKey: boundScope.authorityKey,
        },
        signal,
      });
      // Synchronous stale-observation rejection: a delayed A response that
      // resolves after the switch to B must not activate. The SDK wire
      // guards (`bindRequestAuthority`/`guardResponseAuthority`) already
      // refuse dispatch and body reads for a replaced scope; this covers
      // the same ordering for any transport that resolved anyway.
      if (!boundScope.isCurrent()) throw new StationRequestAuthorityError();
      return observation;
    },
    enabled: observationKey !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const liveObservation =
    observationKey !== null && observationQuery.status === 'success'
      ? (observationQuery.data as AuthorityObservation)
      : null;
  // Belt-and-braces: only a settled success for the CURRENT key commits.
  // While a switch's observation is in flight, `liveObservation` is null —
  // the old client is already retired below, so the tree shows the
  // switching state rather than the previous authority's data.
  const verifiedNamespace = liveObservation
    ? buildAuthorityNamespace(liveObservation)
    : null;

  const observationFailed =
    observationKey !== null && observationQuery.status === 'error';
  const unauthorized =
    observationFailed &&
    isUnauthorizedObservationFailure(observationQuery.error);

  const [rememberedNamespace, setRememberedNamespace] = useState<string | null>(
    () => readLastVerifiedNamespace(),
  );
  useEffect(() => {
    if (verifiedNamespace) {
      writeLastVerifiedNamespace(verifiedNamespace);
      setRememberedNamespace(verifiedNamespace);
    }
  }, [verifiedNamespace]);

  // One live client per verified namespace. Retirement happens the moment
  // this namespace stops being verified (switch starts, credential lapses) —
  // NOT when the next namespace verifies — so a retired client's legacy
  // `_getApiBase` fetchers can never observe the new global origin during
  // the switching gap. While unverified the tree shows loading (pending) or
  // the quarantined paths below (failed); never the old client's data.
  const [active, setActive] = useState<ActiveAuthorityClient | null>(null);
  const activeRef = useRef<ActiveAuthorityClient | null>(null);
  useEffect(() => {
    if (!verifiedNamespace) {
      const previous = activeRef.current;
      if (previous) {
        activeRef.current = null;
        setActive(null);
        retireAuthorityClient(previous.queryClient);
      }
      return;
    }
    if (activeRef.current?.namespace === verifiedNamespace) return;
    const previous = activeRef.current;
    const next: ActiveAuthorityClient = {
      namespace: verifiedNamespace,
      queryClient: createAuthorityClient(),
    };
    activeRef.current = next;
    setActive(next);
    if (previous) retireAuthorityClient(previous.queryClient);
  }, [verifiedNamespace]);

  // Boot-payload seed (moved from `main.tsx`): the payload is fetched
  // against the live global origin, so it seeds ONLY while the scope that
  // verified this namespace is still current — a slow seed resolving after
  // a switch is dropped, never written into the new authority's cache.
  const seededNamespacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!verifiedNamespace || !active || profile.isTauri) return;
    if (active.namespace !== verifiedNamespace) return;
    if (seededNamespacesRef.current.has(verifiedNamespace)) return;
    const scopeAtSeed = boundScope;
    const clientAtSeed = active.queryClient;
    let cancelled = false;
    void (async () => {
      try {
        // Same lazy seam as `main.tsx`'s boot fast path: the SDK boot
        // bundle stays out of the entry chunk; no public SDK barrel change.
        const { fetchAndSeedBootPayload } = await import(
          '../../../packages/sdk/src/boot'
        );
        const resolution = await resolveLocalUiSession(localUiApiBase);
        if (cancelled || resolution.kind !== 'authenticated') return;
        if (scopeAtSeed && !scopeAtSeed.isCurrent()) return;
        await fetchAndSeedBootPayload(clientAtSeed);
        seededNamespacesRef.current.add(verifiedNamespace);
      } catch {
        // Best-effort fast path only; ordinary queries fetch on demand.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verifiedNamespace, active, profile.isTauri, localUiApiBase, boundScope]);

  const activeNamespace = active?.namespace;
  const persistOptions = useMemo(
    () =>
      buildPersistOptions({
        ...(storage ? { storage } : {}),
        ...(persistThrottleTimeMs !== undefined
          ? { throttleTime: persistThrottleTimeMs }
          : {}),
        // Only consumed in the verified branch below, where
        // `activeNamespace === verifiedNamespace` always holds.
        key: authorityPersistenceKey(activeNamespace ?? 'unverified'),
      }),
    [activeNamespace, storage, persistThrottleTimeMs],
  );

  // No active connection, or native binding unavailable: nothing to verify
  // against. Bare children fall through to the nonpersisted bootstrap
  // client above — ephemeral, so first-pairing repair stays usable.
  if (!observationEnabled || !observationKey) {
    return (
      <AuthorityPersistenceContext.Provider
        value={{ status: 'unavailable', namespace: null, observation: null }}
      >
        {children}
      </AuthorityPersistenceContext.Provider>
    );
  }

  // Verified: the namespaced, persisted client. `key` forces a full
  // PersistQueryClientProvider remount per namespace, so each authority
  // restores exactly its own blob through the standard isRestoring gate.
  if (verifiedNamespace && active?.namespace === verifiedNamespace) {
    return (
      <AuthorityPersistenceContext.Provider
        value={{
          status: 'verified',
          namespace: verifiedNamespace,
          observation: liveObservation,
        }}
      >
        <PersistQueryClientProvider
          key={verifiedNamespace}
          client={active.queryClient}
          persistOptions={persistOptions}
        >
          {children}
        </PersistQueryClientProvider>
      </AuthorityPersistenceContext.Provider>
    );
  }

  // Observation failed. A remembered namespace restores its blob for
  // reading (unverified — never current authorization); otherwise, or on a
  // 401 that proves the credential is rejected, run ephemeral. Either way
  // the repair/onboarding surfaces stay mounted.
  if (observationFailed) {
    if (!unauthorized && rememberedNamespace) {
      return (
        <AuthorityPersistenceContext.Provider
          value={{
            status: 'unverified',
            namespace: rememberedNamespace,
            observation: null,
          }}
        >
          <EphemeralUnverifiedTree
            namespace={rememberedNamespace}
            storage={storage}
          >
            {children}
          </EphemeralUnverifiedTree>
        </AuthorityPersistenceContext.Provider>
      );
    }
    // Bare `children` with NO query provider of its own: reads fall through
    // to the nonpersisted bootstrap client above, so nothing persists while
    // unauthorized and the onboarding/first-pairing repair surfaces keep
    // working.
    return (
      <AuthorityPersistenceContext.Provider
        value={{ status: 'unavailable', namespace: null, observation: null }}
      >
        {children}
      </AuthorityPersistenceContext.Provider>
    );
  }

  // Resolving (initial boot or switching): honest loading, not the previous
  // authority's data. Accessible status preserves the existing loading UX.
  return (
    <AuthorityPersistenceContext.Provider
      value={{ status: 'unavailable', namespace: null, observation: null }}
    >
      <SkeletonBlock label="Verifying Station authority" />
    </AuthorityPersistenceContext.Provider>
  );
}

/**
 * Offline/old-server path: restore the remembered namespace's blob into an
 * EPHEMERAL client (no persister subscription, so nothing writes back under
 * an unverified identity) for cache-first reading. Mutations are never
 * hydrated — `shouldDehydrateQuery` already excludes them at save time, and
 * no persister here means nothing is saved at all.
 */
function EphemeralUnverifiedTree({
  children,
  namespace,
  storage,
}: {
  children: ReactNode;
  namespace: string;
  storage?: AsyncStorage<string>;
}): ReactNode {
  const [client] = useState(() => createAuthorityClient());
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const options = buildPersistOptions({
          ...(storage ? { storage } : {}),
          throttleTime: 0,
          key: authorityPersistenceKey(namespace),
        });
        await persistQueryClientRestore({ queryClient: client, ...options });
      } catch {
        // Unverified restore is best-effort; the tree works empty.
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, namespace, storage]);
  // Children mount only AFTER the remembered blob lands: without the
  // provider's `isRestoring` gate, an immediate mount would subscribe to an
  // empty cache and fetch past the very snapshot this path exists to show.
  // (The verified path gets the same gate from PersistQueryClientProvider.)
  if (!restored) return null;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
