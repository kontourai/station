import type { QueryClient } from '@tanstack/react-query';

/**
 * #2307: the `QueryClient` each apiBase's orchestration stream writes through.
 *
 * Kept apart from `ensureOrchestrationEventStream` so the eager authority
 * subtree (`SessionReadModelProvider`) can register its client without pulling
 * the stream, its event handlers and their projections into the entry chunk.
 *
 * There is no single app-lifetime client. `AuthorityQueryContext` mints a
 * FRESH client per verified authority namespace (and a fresh ephemeral one for
 * every unverified fallback) and replaces its whole protected subtree when
 * that changes, while the stream is module-scoped per apiBase and outlives
 * any one of those subtrees. So the client is not bound to the stream's
 * closure: the authority query subtree registers its client independently of
 * the optional dock and releases it on unmount, and every
 * consumer resolves the CURRENT registration for its apiBase when it
 * runs. A retired authority's subtree unmounts before (or in the same commit
 * as) `retireAuthorityClient`, so its client stops receiving invalidations
 * and reconnect refetches at that point, and a stream whose apiBase has no
 * mounted authority subtree writes into no cache at all.
 *
 * The registry is keyed by apiBase, not by authority. A principal switch on
 * the SAME apiBase does not by itself reconnect a live stream (credential
 * change only wakes a parked one), so until that connection cycles, facts it
 * carries under the previous principal invalidate the new authority's client.
 * Invalidation carries no payload — the new client refetches under its own
 * credential — so the effect is spurious refetches, not cross-authority data;
 * a reconnect-fallback snapshot always arrives on a fresh connect, which does
 * carry the current credential.
 *
 * A list, not a slot: more than one dock can mount at once (a docked and a
 * full-screen Chat share one authority's client), and releasing one of them
 * must not unregister the other. Each registration is its own entry, so a
 * release removes exactly that one; the last live entry for an apiBase wins.
 */
const streamQueryClients: {
  apiBase: string;
  queryClient: QueryClient;
  authorityKey?: string;
}[] = [];

/**
 * Refresh scheduling, per apiBase: a stream for a Station the user switched
 * away from keeps running, and its frames must not hold the live Station's
 * window or wait. Owned here because releasing the last registration for an
 * apiBase must cancel that apiBase's pending refresh.
 */
export interface SessionReadModelRefreshState {
  lastAt: number;
  deferred: ReturnType<typeof setTimeout> | undefined;
  /** Unsubscribes the wait for an in-flight read to settle. */
  awaitingSettle: (() => void) | undefined;
  /** An update arrived during the in-flight read; re-read once it settles. */
  owed: boolean;
  /** #4266: the conversation inventory's own refresh, throttled apart. */
  inventoryLastAt: number;
  inventoryDeferred: ReturnType<typeof setTimeout> | undefined;
}
const sessionReadModelRefreshes = new Map<
  string,
  SessionReadModelRefreshState
>();

export function sessionReadModelRefreshState(
  apiBase: string,
): SessionReadModelRefreshState {
  let state = sessionReadModelRefreshes.get(apiBase);
  if (!state) {
    state = {
      lastAt: 0,
      deferred: undefined,
      awaitingSettle: undefined,
      owed: false,
      inventoryLastAt: 0,
      inventoryDeferred: undefined,
    };
    sessionReadModelRefreshes.set(apiBase, state);
  }
  return state;
}

export function currentStreamQueryClient(
  apiBase: string,
): QueryClient | undefined {
  return streamQueryClients.filter((entry) => entry.apiBase === apiBase).at(-1)
    ?.queryClient;
}

/** The authority the newest registration of `client` for `apiBase` carries. */
export function currentStreamAuthorityKey(
  apiBase: string,
  client: QueryClient,
): string | undefined {
  for (let index = streamQueryClients.length - 1; index >= 0; index--) {
    const entry = streamQueryClients[index];
    if (
      entry.apiBase === apiBase &&
      entry.queryClient === client &&
      entry.authorityKey !== undefined
    )
      return entry.authorityKey;
  }
  return undefined;
}

export function registerOrchestrationStreamQueryClient(
  apiBase: string,
  queryClient: QueryClient,
  authorityKey?: string,
): () => void {
  const registration = { apiBase, queryClient, authorityKey };
  streamQueryClients.push(registration);
  return () => {
    const index = streamQueryClients.indexOf(registration);
    if (index !== -1) streamQueryClients.splice(index, 1);
    if (!currentStreamQueryClient(apiBase)) {
      const state = sessionReadModelRefreshes.get(apiBase);
      if (state?.deferred !== undefined) clearTimeout(state.deferred);
      if (state?.inventoryDeferred !== undefined)
        clearTimeout(state.inventoryDeferred);
      state?.awaitingSettle?.();
      sessionReadModelRefreshes.delete(apiBase);
    }
  };
}

/** Test-only: see `resetSessionReadModelRefreshForTests`. */
export function resetStreamQueryClientRegistryForTests(): void {
  for (const state of sessionReadModelRefreshes.values()) {
    if (state.deferred !== undefined) clearTimeout(state.deferred);
    if (state.inventoryDeferred !== undefined)
      clearTimeout(state.inventoryDeferred);
    state.awaitingSettle?.();
  }
  sessionReadModelRefreshes.clear();
  streamQueryClients.length = 0;
}
