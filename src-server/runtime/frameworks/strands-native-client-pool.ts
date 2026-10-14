import {
  type MCPLocalClaim,
  type MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from '@kontourai/station-shared/mcp';
import type { McpClient } from '@strands-agents/sdk';

export type NativeClientEntry = {
  current: boolean;
  claim: MCPLocalClaim;
  client?: McpClient;
  creation?: Promise<McpClient>;
};
// This is a publication projection of the existing per-runtime custody owner.
export const nativeStationControlPools = new Map<
  MCPLocalConnectionCustody,
  Map<string, NativeClientEntry>
>();

/** Bounded local SDK-handle retirement, never descendant/remote drain proof. */
export async function releaseAllNativeStationControlClients(
  owner?: MCPLocalConnectionCustody,
): Promise<void> {
  const settlements: Promise<unknown>[] = [];
  for (const [custody, pool] of nativeStationControlPools) {
    if (owner && custody !== owner) continue;
    const selected = [...pool];
    for (const [, entry] of selected) entry.current = false;
    settlements.push(
      custody
        .releaseClaims(selected.map(([, entry]) => entry.claim))
        .then((cleanup) => {
          if (cleanup.state !== 'settled')
            throw new MCPLocalCustodyError(cleanup.state);
          for (const [id, entry] of selected)
            if (pool.get(id) === entry) pool.delete(id);
          if (!pool.size) nativeStationControlPools.delete(custody);
        }),
    );
  }
  const results = await Promise.allSettled(settlements);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Native station-control cleanup failed.');
}
