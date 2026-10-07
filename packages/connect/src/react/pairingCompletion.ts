import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type { SavedConnection, StationHandshakeIdentity } from '../core/types';
import type { PairingResult } from './DevicePairingPanel';

/**
 * The host-owned primitives every successful device-pairing exchange commits
 * through. Deliberately the same shape `ConnectionsContext` exposes
 * (`commitVerifiedPairing`, `setActiveConnection`, `setCredential`,
 * `markDeviceSession`) so a caller can pass the context's own values straight
 * through without adapting them.
 */
export interface PairingCompletionDeps {
  activeConnection?: SavedConnection | null;
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
  reconcileHandshake?: (
    id: string,
    handshake: StationHandshakeIdentity,
  ) => SavedConnection | null;
  commitEndpointCandidate?: (id: string) => SavedConnection | null;
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
  /** Save Device access while retaining the caller's selected Station. */
  activate?: boolean;
  /** A verified exchange approves its exact endpoint, including an identity merge. */
  bindApprovedEndpoint?: boolean;
  /** First-device setup may adopt its own still-unverified candidate. */
  preserveSelectedStation?: boolean;
}

/**
 * The post-exchange completion every successful device-pairing flow shares:
 * commit the verified identity through the host-owned vault (native OS
 * keyring + profile `credentialRef` on desktop; the browser-local vault
 * everywhere else), then activate it unless the caller is saving access for later use.
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
  if (result.device.kind === 'delegation') {
    throw new Error(
      'Peer Station access cannot be saved as this device’s interactive access. Connect it as a peer instead.',
    );
  }
  const active = deps.activeConnection;
  const firstDeviceCandidate =
    target.preserveSelectedStation === false &&
    active?.id === target.connectionId &&
    !active.environmentId &&
    active.credentialState === 'required';
  if (
    target.bindApprovedEndpoint &&
    target.activate === false &&
    active &&
    !firstDeviceCandidate &&
    (active.id === target.connectionId ||
      active.environmentId === result.environmentId ||
      new URL(active.url).origin === new URL(target.endpoint).origin)
  ) {
    const conflict = new Error(
      'Access was approved, but saving it would replace your currently selected Station’s access or route. Your current route and credential are kept. Use Reconnect or Request access in Stations to explicitly replace that access.',
    );
    conflict.name = 'PairingControllerEndpointConflict';
    throw conflict;
  }
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
  let connectionId = persistedConnectionId ?? target.connectionId;
  if (target.bindApprovedEndpoint && !deps.commitVerifiedPairing) {
    const approved = deps.reconcileHandshake?.(connectionId, handshake);
    if (!approved || approved.environmentId !== result.environmentId) {
      throw new Error('The approved Station identity could not be saved.');
    }
    const bound =
      approved.endpointCandidate?.url === target.endpoint &&
      approved.endpointCandidate.state === 'confirmation-required'
        ? deps.commitEndpointCandidate?.(approved.id)
        : approved;
    if (!bound || bound.url !== target.endpoint) {
      throw new Error('The approved Station address could not be saved.');
    }
    connectionId = bound.id;
  }
  if (result.browserSession) {
    deps.markDeviceSession(connectionId);
  } else if (result.credential) {
    deps.setCredential(connectionId, result.credential);
  }
  if (target.activate !== false) await deps.setActiveConnection(connectionId);
  // Optional host hook (station#1954): mobile shells fire a success haptic
  // without connect needing a platform dependency.
  deps.onPairingSucceeded?.();
  return connectionId;
}
