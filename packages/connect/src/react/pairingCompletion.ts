import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type { StationHandshakeIdentity } from '../core/types';
import type { PairingResult } from './DevicePairingPanel';

/**
 * The host-owned primitives every successful device-pairing exchange commits
 * through. Deliberately the same shape `ConnectionsContext` exposes
 * (`commitVerifiedPairing`, `setActiveConnection`, `setCredential`,
 * `markDeviceSession`) so a caller can pass the context's own values straight
 * through without adapting them.
 */
export interface PairingCompletionDeps {
  commitVerifiedPairing?: (input: {
    connectionId: string;
    name: string;
    endpoint: string;
    handshake: StationHandshakeIdentity;
    clientInstanceId: string;
    credential?: string;
    credentialHandle?: string;
    nextCredentialRef?: StationProfileCredentialRef;
  }) => Promise<string | undefined>;
  setActiveConnection: (id: string) => Promise<void>;
  setCredential: (id: string, credential: string) => void;
  markDeviceSession: (id: string) => void;
  /**
   * Optional success side-effect after the connection is active (station#1954
   * mobile haptics). Connect stays free of platform imports.
   */
  onPairingSucceeded?: () => void;
}

export interface PairingCompletionTarget {
  /** The connection this pairing is committed against — may already exist. */
  connectionId: string;
  name: string;
  endpoint: string;
}

/**
 * The post-exchange completion every successful device-pairing flow shares:
 * commit the verified identity through the host-owned vault (native OS
 * keyring + profile `credentialRef` on desktop; the browser-local vault
 * everywhere else), then activate it as the current connection.
 *
 * Extracted from `ConnectionManagerModalContent`'s access-request completion /
 * `handlePaired` (station#1715) so a caller outside that component — the
 * same-user local self-provision attempt (`attemptLocalSelfProvision`,
 * `packages/connect/src/core/localSelfProvision.ts`) — reuses the exact same
 * commit-then-activate sequence rather than a parallel reimplementation that
 * could silently drift from it. Both call sites still own their own
 * surrounding decisions (compatibility gating, panel state, connection-list
 * bookkeeping); only this shared tail moved.
 */
export async function completeVerifiedPairing(
  deps: PairingCompletionDeps,
  target: PairingCompletionTarget,
  result: PairingResult,
): Promise<string> {
  const handshake: StationHandshakeIdentity = {
    environmentId: result.environmentId,
    authentication: { scheme: 'bearer', protocolVersion: 1 },
  };
  const persistedConnectionId = await deps.commitVerifiedPairing?.({
    connectionId: target.connectionId,
    name: target.name,
    endpoint: target.endpoint,
    handshake,
    clientInstanceId: result.clientInstanceId,
    ...(result.credential ? { credential: result.credential } : {}),
    ...(result.credentialHandle
      ? { credentialHandle: result.credentialHandle }
      : {}),
    ...(result.credentialRef
      ? { nextCredentialRef: result.credentialRef }
      : {}),
  });
  const connectionId = persistedConnectionId ?? target.connectionId;
  if (result.browserSession) {
    deps.markDeviceSession(connectionId);
  } else if (result.credential) {
    deps.setCredential(connectionId, result.credential);
  }
  await deps.setActiveConnection(connectionId);
  // Optional host hook (station#1954): mobile shells fire a success haptic
  // without connect needing a platform dependency.
  deps.onPairingSucceeded?.();
  return connectionId;
}
