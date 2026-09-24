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
 *    connection id, credential authority generation, credential state) PLUS
 *    the live request scope's `authorityKey` (connection id, activation
 *    epoch, authority generation, credential state) AND refetched on every
 *    activation mount (`staleTime: 0`, `refetchOnMount: 'always'`). The
 *    activation segment is what closes the A->B->A hole: returning to A
 *    advances the activation epoch even when every row fact is unchanged,
 *    so the return trip is a new key with no cached success to revive.
 *    The principal itself is always closed server fact, never cookie
 *    contents, endpoint text, or a profile label. (Reconnect without a
 *    switch keeps key and namespace; the reconnect invalidation re-reads
 *    DATA under it, and any 401 there drives a credential transition,
 *    which re-observes.)
 *  - Verification additionally requires the CURRENT key's success to be
 *    settled with no fetch in flight (`fetchStatus === 'idle'`):
 *    `refetchOnMount: 'always'`/`staleTime: 0` deliberately keep cached
 *    success data during a background re-read, and `status === 'success'`
 *    stays true through it — accepting that would expose the previous
 *    activation's subtree while the new identity is still pending. The
 *    durable namespace itself stays observation-facts-only (stable across
 *    activations); only the observation KEY carries liveness.
 *  - Each verified namespace gets a FRESH `QueryClient` under its own
 *    `PersistQueryClientProvider` with a disjoint IndexedDB key, so two
 *    homes sharing project ids (or one endpoint serving two principals)
 *    can never collide. Retirement fires the moment verification lapses
 *    (not when the next namespace verifies) — see the `_getApiBase` audit.
 *  - No observation (old server, offline, unpaired, 401) is explicit
 *    unavailable/unverified status, never guessed identity: stored shelves
 *    stay on disk verbatim but are NEVER hydrated or shown without a live
 *    observation — a flag cannot quarantine a blob once mounted children
 *    can read it. These paths run on a FRESH ephemeral client of their own
 *    (never the observation bootstrap client), so first-pairing repair
 *    stays usable with nothing persisted and nothing restored.
 *
 * COMPOSITION BOUNDARY (hosted connect-modal regression): this provider
 * replaces its ENTIRE protected subtree on activation transitions
 * (skeleton while pending, fresh keyed client per namespace), so
 * device-local connection selection/pairing/recovery UI must NOT live
 * inside it — an open access-request flow would unmount mid-transition.
 * That shell (`OnboardingGate`) mounts ABOVE this provider in
 * `RecoveryQueryBoundary` (stable nonpersisted client, switch-scoped cache
 * drop; archive#1290 switch invalidation stays here with the client it
 * targets), and only protected data lifetimes are replaceable here. Toast
 * and navigation state are likewise stable above; nothing below may assume
 * a provider remount clears them.
 *
 * `_getApiBase` AUDIT (the seam a per-context client alone does not close):
 * legacy SDK query-domain fetchers resolve the module-global origin AT
 * FETCH TIME (`await _getApiBase()` inside the queryFn). A delayed legacy
 * fetcher from a retired client could therefore resolve the NEW global
 * origin after a switch. Integrated guards, in order:
 *   1. Retirement cancels: `cancelQueries()` on the old client clears
 *      scheduled retries/refetch timers and aborts signal-abiding in-flight
 *      fetches (every `useApiQuery` fetch receives its AbortSignal, and a
 *      fetch issued with an already-aborted signal never dispatches, per
 *      spec — proven by the legacy-pattern integration test, which holds a
 *      deferred base resolution plus retries open across a real global
 *      switch and asserts zero post-switch dispatches).
 *   2. The provider unmount that follows drops all observers and
 *      unsubscribes the persister. (`QueryClient.unmount` is only a
 *      focus/online-manager refcount and is deliberately NOT called
 *      manually — pairing it with the provider's own unmount would
 *      double-decrement shared-manager subscriptions.)
 *   3. Scoped fetchers (Project read/reorder, search, and every fetcher
 *      that threads `requestScope`) additionally throw
 *      `StationRequestAuthorityError` at dispatch AND at body-read time when
 *      their captured scope no longer matches the live authority.
 *   4. The boot-payload seed below resolves NO module-global: it fetches at
 *      the captured origin string and `seedBootPayloadGuarded` evaluates
 *      the captured scope's currency AND the destination client's liveness
 *      immediately before EACH cache write, so a same-origin rotation
 *      resolving mid-fetch drops every write. Runs only when the verified
 *      scope is the page's own origin.
 * Residual (stated, not covered): real SDK callers `useUserLookup` and
 * `useServerFetch` (packages/sdk/src/hooks/operations.ts) resolve the
 * global origin at fetch time and thread NO AbortSignal, so retirement
 * `cancelQueries` cannot abort them. Their boundary is different, not
 * absent: both hold results in effect-local `useState` (never in any query
 * cache), and the provider remount on namespace change unmounts them, so a
 * late result is discarded by the effect's cancelled flag and can never be
 * persisted to any shelf. That is unmount-discard, not cancellation — a
 * same-tick dispatch under a replaced origin remains possible, and no
 * claim is made here for query domains outside `useApiQuery` (which
 * threads its signal by construction) plus the two named above. Cache
 * clears do not cancel dispatched mutations, and root contexts/drafts/
 * queued turns/deep links remain independent later exits — this slice
 * claims query partition only, never full #481.
 */

import { useConnections } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  type ApiRequestScope,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
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
} from '@tanstack/react-query-persist-client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  isPluginCommandEffectCookieAuthEligible,
  notifyPluginCommandEffectAuthoritySwitch,
  notifyPluginCommandEffectCookieAuthEligibility,
} from '../components/plugin-command-effect-switch-signal';
import { SkeletonBlock } from '../components/state';
import {
  useConnectionSwitchScope,
  useInvalidateCachesOnConnectionSwitch,
} from '../hooks/useInvalidateCachesOnConnectionSwitch';
import {
  authorityPersistenceKey,
  buildAuthorityNamespace,
} from '../lib/authorityNamespace';
import { resolveLocalUiSession } from '../lib/local-ui-bootstrap';
import { stationQueryDefaults } from '../lib/queryDefaults';
import {
  applyPersistedQueryGcTimeDefaults,
  buildPersistOptions,
} from '../lib/queryPersistence';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { useHostRequestAuthorityScope } from './ApiBaseContext';
import { AuthorityPersistenceContext } from './AuthorityPersistenceContext';
import { activeChatsStore } from './active-chats-store';

export interface AuthorityObservationRequest {
  apiBase: string;
  requestScope: ApiRequestScope | undefined;
  signal: AbortSignal;
}

/** Injectable wire seam: production reads the live endpoint, tests inject deferreds. */
export type FetchAuthorityObservation = (
  request: AuthorityObservationRequest,
) => Promise<AuthorityObservation>;

/**
 * Production observation read with an explicit bounded deadline alongside
 * the caller signal. React Query always supplies a signal, and the SDK
 * resolves "caller owns cancellation" to NO deadline in that case — a
 * black-holed read would hang the recovery shell (and its repair surfaces)
 * forever. The deadline reuses the existing client request policy
 * (`DEFAULT_CLIENT_REQUEST_TIMEOUT_MS`); it composes with the caller
 * signal through the SDK's existing options (`AbortSignal.any`), so a
 * switch/replacement still cancels first and the global SDK timeout
 * behavior is unchanged. A timeout is observation loss: the failure branch
 * below quarantines on a fresh ephemeral client and restores nothing —
 * never permission to revive a shelf.
 */
function defaultFetchAuthorityObservation(
  timeoutMs: number,
): FetchAuthorityObservation {
  return ({ apiBase, requestScope, signal }) =>
    getAuthorityObservation(apiBase, {
      ...(requestScope ? { requestScope } : {}),
      signal,
      timeoutMs,
    });
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

export function createAuthorityClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: stationQueryDefaults() },
  });
  applyPersistedQueryGcTimeDefaults(queryClient);
  return queryClient;
}

/**
 * Retire a replaced authority's client: cancel its scheduled retries,
 * refetch timers, and signal-abiding in-flight fetches FIRST, so no legacy
 * `_getApiBase` fetcher it owns can dispatch against the new global origin
 * (a fetch issued with an already-aborted signal never dispatches, per
 * spec). Observer teardown and persister unsubscribe belong to the
 * `PersistQueryClientProvider` unmount that follows — `QueryClient.unmount`
 * is only a focus/online-manager refcount and must NOT be called manually
 * alongside a provider unmount. See the module audit above.
 */
function retireAuthorityClient(queryClient: QueryClient): void {
  void queryClient.cancelQueries();
}

export function AuthorityQueryProvider({
  children,
  fetchObservation,
  storage,
  localUiApiBase,
  persistThrottleTimeMs,
  observationTimeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
}: {
  children: ReactNode;
  fetchObservation?: FetchAuthorityObservation;
  /** Injected `AsyncStorage` for tests; production uses IndexedDB. */
  storage?: AsyncStorage<string>;
  /** Same-origin API base for the boot-payload seed (`main.tsx`). */
  localUiApiBase: string;
  /** Persister coalescing window; production default (1000ms) when omitted. */
  persistThrottleTimeMs?: number;
  /**
   * Bounded deadline for the production authority observation read.
   * Production default is the existing client request policy; tests inject
   * a short deadline to prove a black-holed read fails bounded onto the
   * repair path instead of hanging.
   */
  observationTimeoutMs?: number;
}): ReactNode {
  const readObservation =
    fetchObservation ?? defaultFetchAuthorityObservation(observationTimeoutMs);
  const { apiBase, activeConnection, credentialAuthorityGeneration } =
    useConnections();
  const requestScope = useHostRequestAuthorityScope();
  const profile = usePlatformProfile();

  const connectionId = activeConnection?.id ?? null;
  const credentialState = activeConnection?.credentialState ?? null;
  const authorityGeneration = connectionId
    ? credentialAuthorityGeneration(connectionId)
    : 0;

  // #1418/#1419 review, MEDIUM: this is the one place that already holds
  // `credentialState`, `profile.isTauri`, and the active connection's broker
  // route together, so the plugin-command-effect coordinator's `pagehide`
  // keepalive eligibility is derived here and pushed through the same
  // always-loaded signal seam `notifyPluginCommandEffectAuthoritySwitch`
  // already uses (the coordinator itself may not be loaded yet).
  const pluginCommandEffectCookieAuthEligible =
    isPluginCommandEffectCookieAuthEligible({
      isTauri: profile.isTauri,
      credentialState,
      hasBrokerRoute: Boolean(activeConnection?.brokerRoute),
    });
  useEffect(() => {
    notifyPluginCommandEffectCookieAuthEligibility(
      pluginCommandEffectCookieAuthEligible,
    );
  }, [pluginCommandEffectCookieAuthEligible]);

  const observationEnabled =
    activeConnection !== null && requestScope !== undefined;
  // The scope this key's fetch is bound to, snapshotted from the render that
  // owns the key. A switch replaces BOTH together, so a queryFn closure can
  // never pair a new scope with an old key or vice versa.
  const boundScope = observationEnabled ? requestScope : undefined;
  const boundApiBase = apiBase;

  const observationKey = observationEnabled
    ? [
        'authority-observation',
        apiBase,
        connectionId,
        authorityGeneration,
        credentialState,
        // Live activation scope. `authorityKey` is a plain string over
        // (connection id, activation epoch, authority generation,
        // credential state), so it is key-stable across renders yet changes
        // on every switch and every credential transition — including a
        // return to a row whose saved facts never changed. Durable identity
        // stays out of the key (see `buildAuthorityNamespace`); this segment
        // is liveness only.
        boundScope?.authorityKey ?? null,
      ]
    : null;

  const observationQuery = useQuery({
    queryKey: observationKey ?? ['authority-observation', 'disabled'],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!boundScope) throw new StationRequestAuthorityError();
      const observation = await readObservation({
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
    // Live read per activation: a cached observation must never count as
    // current verification. A->B->A with a changed A principal (or a
    // revoked/replaced device) must observe the change on return, not revive
    // the previous shelf from cache.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  // A cached success from a previous activation must never verify the
  // current one: while the current key's fetch is in flight React Query
  // keeps `status === 'success'` with the OLD data, so verification
  // additionally requires a settled fetch. Either condition alone is
  // insufficient — the key without the gate revives cache during
  // background re-reads, and the gate without the key would still accept
  // a settled stale key.
  const liveObservation =
    observationKey !== null &&
    observationQuery.status === 'success' &&
    observationQuery.fetchStatus === 'idle'
      ? (observationQuery.data as AuthorityObservation)
      : null;
  const verifiedNamespace = liveObservation
    ? buildAuthorityNamespace(liveObservation)
    : null;

  const observationFailed =
    observationKey !== null && observationQuery.status === 'error';
  const unauthorized =
    observationFailed &&
    isUnauthorizedObservationFailure(observationQuery.error);

  // One live client per verified namespace. Retirement happens the moment
  // this namespace stops being verified (switch starts, credential lapses) —
  // NOT when the next namespace verifies — so a retired client's legacy
  // `_getApiBase` fetchers are cancelled before they can observe the new
  // global origin during the switching gap. While unverified the tree shows
  // loading (pending) or the quarantined paths below (failed); never the
  // old client's data.
  const [active, setActive] = useState<ActiveAuthorityClient | null>(null);
  const activeRef = useRef<ActiveAuthorityClient | null>(null);
  const lastVerifiedNamespaceRef = useRef<string | undefined>(undefined);
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
    // #2309: another Station's activity sequences are not comparable, so the
    // records go when the verified authority CHANGES — not when it is only
    // unverified for a moment during a re-verify of the same one.
    if (
      lastVerifiedNamespaceRef.current !== undefined &&
      lastVerifiedNamespaceRef.current !== verifiedNamespace
    ) {
      activeChatsStore.clearConversationActivity();
      // #1418/#1419: a different Station's ledger is not this document's to
      // settle. Flush what the old identity owes, then mint a fresh one.
      notifyPluginCommandEffectAuthoritySwitch();
    }
    lastVerifiedNamespaceRef.current = verifiedNamespace;
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

  // Boot-payload seed (moved from `main.tsx`): the payload is fetched at the
  // EXACT captured origin — never a module-global resolved after a switch —
  // and the captured scope (currency) plus the destination client (liveness)
  // are retained through fetch AND body decode, then checked immediately
  // before EACH cache write by `seedBootPayloadGuarded`. An origin
  // comparison alone cannot cover same-origin identity changes, so a slow
  // seed resolving after a switch or a same-origin rotation is dropped,
  // never written into another identity's shelf. Additionally the seed runs
  // only when the verified scope IS the page's own origin: the local-UI
  // session proof is meaningless for a remote home, which fetches on demand
  // instead. Seeding is tracked per live client, never in a set that could
  // survive client replacement and skip a new client's seed.
  const seededRef = useRef<{
    namespace: string;
    client: QueryClient;
  } | null>(null);
  useEffect(() => {
    if (!verifiedNamespace || !active || profile.isTauri || !boundScope) return;
    if (active.namespace !== verifiedNamespace) return;
    if (
      seededRef.current?.namespace === verifiedNamespace &&
      seededRef.current.client === active.queryClient
    )
      return;
    let sameOrigin = false;
    try {
      sameOrigin =
        new URL(boundScope.apiBase).origin === new URL(localUiApiBase).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return;
    const scopeAtSeed = boundScope;
    const apiBaseAtSeed = boundScope.apiBase;
    const startedAtSeed = Date.now();
    const clientAtSeed = active.queryClient;
    const namespaceAtSeed = verifiedNamespace;
    let cancelled = false;
    // The exact captured authority, evaluated after every await and before
    // every write: scope currency AND destination-client liveness.
    const stillCurrent = () =>
      !cancelled &&
      scopeAtSeed.isCurrent() &&
      activeRef.current?.queryClient === clientAtSeed;
    void (async () => {
      try {
        // Same lazy seam as `main.tsx`'s boot fast path: the SDK boot
        // bundle stays out of the entry chunk; no public SDK barrel change.
        const { fetchBootPayloadAt, seedBootPayloadGuarded } = await import(
          '../../../packages/sdk/src/boot'
        );
        const resolution = await resolveLocalUiSession(localUiApiBase);
        if (!stillCurrent() || resolution.kind !== 'authenticated') return;
        const payload = await fetchBootPayloadAt(apiBaseAtSeed);
        await seedBootPayloadGuarded(
          clientAtSeed,
          payload,
          startedAtSeed,
          stillCurrent,
        );
        if (!stillCurrent()) return;
        seededRef.current = {
          namespace: namespaceAtSeed,
          client: clientAtSeed,
        };
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

  // Every unverified fallback — no-evidence, old-server, offline, 401 —
  // is keyed on the CURRENT live context tuple, so rendering the same
  // branch for a different home/authority remounts a FRESH ephemeral client
  // instead of reusing the previous fallback's cache (colliding private
  // keys such as `['projects']` must never survive the context change).
  const ephemeralKey = JSON.stringify([
    apiBase,
    connectionId,
    authorityGeneration,
    credentialState,
    requestScope?.authorityKey ?? null,
  ]);

  // No active connection, or native binding unavailable: nothing to verify
  // against. Children run on their OWN fresh ephemeral client — never the
  // shared observation bootstrap client, whose cache is observation-only —
  // so first-pairing repair stays usable with no persistence to guess from.
  if (!observationEnabled || !observationKey) {
    return (
      <AuthorityPersistenceContext.Provider
        value={{ status: 'unavailable', namespace: null, observation: null }}
      >
        <EphemeralTree key={ephemeralKey}>
          <AuthoritySwitchInvalidator />
          {children}
        </EphemeralTree>
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
          <AuthoritySwitchInvalidator />
          {children}
        </PersistQueryClientProvider>
      </AuthorityPersistenceContext.Provider>
    );
  }

  // Observation failed: NEVER hydrate or show a remembered namespace under
  // unverified current authority — a context flag cannot quarantine a blob
  // once mounted children can read it. Stored shelves stay on disk verbatim
  // for the next verified activation; this tree runs on a fresh ephemeral
  // client (old server, offline, and 401 all land here — a 401 additionally
  // reports 'unavailable' so repair surfaces know the credential itself was
  // refused). Either way the repair/onboarding surfaces stay mounted.
  if (observationFailed) {
    return (
      <AuthorityPersistenceContext.Provider
        value={{
          status: unauthorized ? 'unavailable' : 'unverified',
          namespace: null,
          observation: null,
        }}
      >
        <EphemeralTree key={ephemeralKey}>
          <AuthoritySwitchInvalidator />
          {children}
        </EphemeralTree>
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
 * archive#1290 switch invalidation, kept with the client it targets. The
 * recovery/pairing shell (`OnboardingGate`) now mounts ABOVE this provider
 * inside its own stable `RecoveryQueryBoundary`, so it can no longer host
 * this hook: `useQueryClient` there resolves the recovery client, and
 * invalidating that cache would leave the protected one serving the
 * previous server. Rendered in every branch that owns a query client
 * (verified persisted, both ephemeral fallbacks) — exactly the branches the
 * gate previously reached through the mounted children. Never in the
 * pending branch: there is no client to invalidate while unverified (the
 * retired client was cancelled on the way out, the next one is fresh on
 * the way in), and mounting one there would invalidate the observation
 * bootstrap client instead.
 */
function AuthoritySwitchInvalidator(): ReactNode {
  const { apiBase, hasActiveConnection, connectionScope } =
    useConnectionSwitchScope();
  useInvalidateCachesOnConnectionSwitch(
    apiBase,
    hasActiveConnection,
    connectionScope,
  );
  return null;
}

/**
 * Quarantined path: a FRESH nonpersisted client per mount — no persister
 * subscription (nothing is saved under an unverified identity) and no
 * restore (no remembered shelf is ever hydrated without a live
 * observation). Reads fetch live or fail honestly; repair surfaces work.
 * Callers MUST pass `key` bound to the current live context tuple: without
 * it, consecutive fallbacks for different homes would share one client and
 * colliding private keys would leak across the context change.
 */
function EphemeralTree({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(() => createAuthorityClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
