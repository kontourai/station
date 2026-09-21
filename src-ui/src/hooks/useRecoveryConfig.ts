/**
 * Identity-scoped config read for the stable recovery shell
 * (`RecoveryQueryBoundary` / `OnboardingGate` / `UsageTelemetryDisclosure`).
 *
 * The shared `useConfigQuery` uses the bare key `['config']` and resolves
 * its origin through a global getter at fetch time. That is correct under
 * the authority tree's per-namespace clients (the client IS the scope), but
 * the recovery boundary owns ONE stable client across activation
 * transitions — a bare entry written under connection A would match a read
 * under connection B (or under A's rotated credential), serving stale data
 * to the render AND to any child layout effect that runs before the
 * boundary's own reset effect. No reset timing can close that: the fix is
 * structural.
 *
 * This hook keys by explicit origin AND live activation identity
 * (`RecoveryScopeContext`: apiBase + the request scope's activation key,
 * which advances on every activation and on same-origin credential
 * changes), and dispatches through `getJson` with the render-captured
 * `ClientRequestOptions['requestScope']` plus an explicit finite
 * `timeoutMs` alongside the caller's AbortSignal. The SDK compares the
 * capture against the live credential-resolver settlement before dispatch
 * AND around the body read: a rotation between render and dispatch fails
 * the dispatch, and a deferred old body fails the decode, both with
 * `StationRequestAuthorityError` — neither a wrong-credential dispatch
 * nor an old body can populate the current recovery view. A switch or
 * rotation therefore NEVER matches a previous entry: the render commits
 * pending, never stale.
 *
 * Outside the recovery boundary the hook is inert (disabled, no fetch):
 * shared components owned by both trees call it unconditionally and read
 * the protected `useConfigQuery` path instead, so no caller throws for
 * rendering in the tree that owns most of its surfaces.
 *
 * Protected-tree consumers keep `useConfigQuery` (bare key, correctly
 * namespaced by their per-authority client). The write side
 * (`useUpdateConfigMutation`) invalidates the bare key only; recovery
 * writers invalidate the scoped key explicitly at their own call site.
 */

import { getJson } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
} from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';

/** The cache key, exported so writers invalidate exactly what this reads. */
export function recoveryConfigKey(apiBase: string, identityKey: string) {
  return ['config', 'recovery', apiBase, identityKey] as const;
}

async function fetchRecoveryConfig(
  apiBase: string,
  requestScope: ApiRequestScope | null,
  signal: AbortSignal | undefined,
) {
  const response = await getJson(`${apiBase}/config/app`, {
    signal,
    timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
    ...(requestScope ? { requestScope } : {}),
  });
  // Guarded when scoped: `getJson` wraps the body readers, so the decode
  // below re-asserts the capture is still current after the bytes arrive.
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

export function useRecoveryConfig() {
  const scope = useOptionalRecoveryScope();
  return useQuery({
    queryKey: scope
      ? recoveryConfigKey(scope.apiBase, scope.identityKey)
      : (['config', 'recovery', 'absent'] as const),
    queryFn: ({ signal }) =>
      fetchRecoveryConfig(
        scope?.apiBase ?? '',
        scope?.requestScope ?? null,
        signal,
      ),
    enabled: scope !== null,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
