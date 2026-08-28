/**
 * archive#1290 — server-scoped React Query caches are not namespaced by
 * `apiBase`. Every query-domain fetcher (`packages/sdk/src/query-domains/*`)
* resolves `_getApiBase` inside the fetcher itself, so switching the
 * active connection left every previously-populated query — agents, model
 * connections, sessions, and more — still serving the *previous* server's
 * data until each query's own stale timer or an unrelated mutation happened
 * to refetch it. The switch path only ever refetched system status
 * (`OnboardingGate`'s own `connectionEvidence` effect); nothing invalidated
 * the rest.
 *
 * Fix shape: invalidate the WHOLE query cache once per genuine switch —
* `queryClient.invalidateQueries` with no filter marks every query stale
 * and triggers a refetch of the ones currently observed, against the new
 * `apiBase` — rather than a targeted per-key list. The query-domain surface
* is ~35 files; roughly a third of them reach `_getApiBase` only
 * indirectly (barrel re-exports, shared request helpers in a sibling file),
 * so an enumerated allowlist would silently rot as new domains are added.
 * Deeper fix, deliberately deferred: namespace every query key by `apiBase`
 * (or a connection epoch) so a switch never needs a blanket invalidate at
 * all — noted on the PR, not attempted here.
 *
 * INVALIDATE, NEVER CLEAR ( 1 finding). The app is wrapped in
 * `<PersistQueryClientProvider>` (`main.tsx`), which persists a whitelisted
 * key set to IndexedDB (`../lib/queryPersistence.ts`, archive#1223/archive#1250:
 * agents/conversations/projects/runs/system-status/config).
* `queryClient.clear` emits a `removed` event for every query;
 * `persistQueryClientSubscribe` re-dehydrates the *live* cache on every such
* event, so a `clear` here overwrites the durable IndexedDB snapshot with
 * an EMPTY one within the persister's throttle window — silently destroying
 * the offline cache-first read archive#1223 exists for, on every switch.
* `invalidateQueries` marks queries stale and refetches the ones
 * currently mounted; it never removes cached data or emits `removed`, so
 * the persisted snapshot is untouched and a component still reads the
 * (now-stale-flagged) data instantly while the refetch is in flight — the
 * same "invalidate, not evict" contract this repo already established for
 * `useQueryCacheReconnectSync` / `invalidatePersistedQueries` (reconnect
 * invalidation, same file). This hook is the connection-switch analog of
 * that reconnect path; it does not abort in-flight mutations or open
 * streams (SSE/chat) — those keep running against whatever `apiBase` they
 * captured when they started, same as a reconnect invalidation.
 *
 * TWO GUARDS AGAINST A BOOT-TIME FALSE POSITIVE ( 1). On a
 * native desktop shell that supervises its own bundled server, `apiBase`
 * resolves in two stages — the `DEFAULT_API_BASE` placeholder on first
 * render, then the real bundled-loopback URL once `useBundledServerStatus`
 * resolves post-mount (`ApiBaseContext.tsx`). That transition is initial
 * boot settling, not a user-initiated switch, and happens once on every
 * native launch before any query has fetched anything — invalidating there
 * is wasted work and can race the persisted-cache restore.
 *
*  1. `hasActiveConnection` (caller passes `activeConnection != null`): the
*     FIRST transition from no active connection to one is establishment,
*     never a switch. `apiBase` and `hasActiveConnection` are both read
* from the same `useConnections` snapshot in the same render (see
*     `ConnectionsContext.tsx`'s single `useMemo`), so there is no render
*     lag between them the way there would be gating on a
*     separately-sourced platform/bundled-server signal instead: verified
*     against the real component tree that `OnboardingGate`'s own
*     `bundledStatus`-derived "past the boot screen" state updates one
*     render *before* the store's `apiBase` actually changes (the store
*     update happens in a downstream effect) — gating on that boolean would
*     still seed the wrong baseline one render too early. Gating on
*     `hasActiveConnection` instead avoids that lag entirely because it
*     comes from the exact same context value as `apiBase`.
* 2. `useIsRestoring`: while the persisted cache is still restoring from
*     IndexedDB, this hook defers entirely (no baseline update, no
*     invalidate) — invalidating before restore settles fights the
*     cache-first-then-refetch contract the persister exists for. Nothing
*     is lost: `isRestoring` is a dependency, so the effect re-evaluates the
*     moment it flips back to false, against whatever changed meanwhile.
 */
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export function useInvalidateCachesOnConnectionSwitch(
  apiBase: string,
  hasActiveConnection: boolean,
  connectionScope: string | null = null,
): void {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const previousRef = useRef({
    apiBase,
    hasActiveConnection,
    connectionScope,
  });

  useEffect(() => {
// Deferred, not skipped: isRestoring is a dependency below, so this
// re-evaluates against the latest values the moment restore settles.
    if (isRestoring) return;

    const previous = previousRef.current;
    previousRef.current = { apiBase, hasActiveConnection, connectionScope };

// Initial establishment (no active connection -> one) — including the
// native two-stage apiBase resolution described above — is never a
// switch, regardless of how many boot-settling renders it took.
    if (!previous.hasActiveConnection && hasActiveConnection) return;

// Distinct saved Stations can intentionally share one endpoint. Their
// credential/identity boundary is still a real server-context switch:
// retaining an auth-scoped workspace cache here can render an unrelated
// workspace as a generic load failure. The active profile identity is
// therefore part of the switch key alongside the origin.
    if (
      previous.apiBase === apiBase &&
      previous.connectionScope === connectionScope
    )
      return;

    void queryClient.invalidateQueries();
  }, [apiBase, hasActiveConnection, connectionScope, isRestoring, queryClient]);
}
