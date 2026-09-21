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
 * changes), and dispatches against the explicit origin — never a global
 * getter — with the caller's AbortSignal threaded, so rotation aborts
 * in-flight old-credential reads. A switch or rotation therefore NEVER
 * matches a previous entry: the render commits pending, never stale.
 *
 * Protected-tree consumers keep `useConfigQuery` (bare key, correctly
 * namespaced by their per-authority client). The write side
 * (`useUpdateConfigMutation`) invalidates the bare key only; recovery
 * writers invalidate the scoped key explicitly at their own call site.
 */

import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useRecoveryScope } from '../contexts/RecoveryQueryBoundary';

/** The cache key, exported so writers invalidate exactly what this reads. */
export function recoveryConfigKey(apiBase: string, identityKey: string) {
  return ['config', 'recovery', apiBase, identityKey] as const;
}

async function fetchRecoveryConfig(
  apiBase: string,
  signal: AbortSignal | undefined,
) {
  const response = await authenticatedFetch(`${apiBase}/config/app`, {
    signal,
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

export function useRecoveryConfig() {
  const { apiBase, identityKey } = useRecoveryScope();
  return useQuery({
    queryKey: recoveryConfigKey(apiBase, identityKey),
    queryFn: ({ signal }) => fetchRecoveryConfig(apiBase, signal),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
