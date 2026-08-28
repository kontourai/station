import type { WorkspaceHomeRoleStatus } from '@kontourai/station-contracts/workspace-home-role';
import {
  useRevokeWorkspaceHomeRoleMutation,
  useWorkspaceHomeRoleQuery,
  WORKSPACE_HOME_ROLE_QUERY_KEY,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { pluginRegistry } from '../../core/PluginRegistry';

/**
 * The Home role's client seam (archive#3122).
 *
 * There is deliberately NO browser-side store and NO client-side grant
 * writer here. The grant record lives server-side — a
 * `trusted-plugin-react` renderer runs as same-origin JavaScript, so
 * anything the page can write (an earlier revision used localStorage) is
 * something the granted party can write to itself. The client only READS
 * the server's derived status, and the SDK fetcher reparses it fail-closed
 * through the contract, so a malformed payload lands on the built-in floor.
 *
 * The status DOES pass through the shared TanStack Query cache, so the
 * honest authority rule is not "no cache" but this: **a cached `granted`
 * never survives the server being unable to affirm it.** When the last
 * read errored (store corrupt, server 503, wire down), this hook returns
 * `undefined` even though the cache still holds the previous payload — the
 * floor renders until a read succeeds again. Rendering granted plugin code
 * out of a cache the server can no longer vouch for would make the
 * server-side fail-closed store decorative at exactly the layer that
 * mounts code.
 *
 * `undefined` therefore means: not resolved — loading, or the last read
 * failed. Callers render the built-in floor for it — the floor-first
 * direction, identical to today's Home when no grant exists.
 */
export function useWorkspaceHomeRoleStatus():
  | WorkspaceHomeRoleStatus
  | undefined {
  const queryClient = useQueryClient();
  // One retry, not the client-wide three-with-backoff default: this read is
  // an AUTHORITY projection, and every second spent retrying is a second a
  // cached `granted` keeps mounting code the server can no longer vouch
  // for. One retry absorbs a transient blip; after that the floor renders
  // (the honest, always-safe direction) until a later read succeeds.
  const query = useWorkspaceHomeRoleQuery({ retry: 1 });
  useEffect(() => {
    // A plugin registry reload (install, uninstall, update, reload) is
    // exactly when the server's derivation can change; refetch so an
    // uninstalled or replaced plugin cannot keep rendering out of a stale
    // status for longer than one reload cycle.
    const unsubscribe = pluginRegistry.subscribe(() => {
      queryClient.invalidateQueries({
        queryKey: [...WORKSPACE_HOME_ROLE_QUERY_KEY],
      });
    });
    return () => {
      unsubscribe();
    };
  }, [queryClient]);
  // The authority projection is fail-closed: an errored read means the
  // server could not affirm the cached value, so nothing is affirmed.
  if (query.isError) return undefined;
  return query.data;
}

/** Revocation: removing the record is the whole effect; builtin Home remains. */
export function useRevokeWorkspaceHomeRole(): () => void {
  const mutation = useRevokeWorkspaceHomeRoleMutation();
  return mutation.mutate;
}
