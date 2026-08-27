import {
  createDirectHttpAccessMethod,
  createHostTunnelAccessMethod,
} from './accessMethods';
import type {
  AccessEndpoint,
  EnvironmentAccessMethod,
  SavedConnection,
} from './types';

export function isLoopbackUrl(value: string | undefined): boolean {
  try {
    const hostname = new URL(value ?? '').hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Same web origin (scheme + host + port). Used to decide whether an accepted
 * response actually came from the address a connection currently points at —
 * a connection keeps its ID across a rebind, so the ID alone does not say that.
 */
export function isSameConnectionOrigin(
  a: string | undefined,
  b: string | undefined,
): boolean {
  try {
    return new URL(a ?? '').origin === new URL(b ?? '').origin;
  } catch {
    return false;
  }
}

/**
 * The one derivation of a connection's credential state from what could be
 * carrying its requests. Two callers, and exactly one difference between them,
 * named rather than inlined twice:
 *
 * - Binding an environment (`ConnectionStore.bindNewEnvironment`) has observed
 *   no accepted authenticated request, so an unrecognised remote connection
 *   still needs credentials.
 * - Recovery (`ConnectionStore.recordAuthenticatedSuccess`) is only reached
 *   BECAUSE this Station accepted an authenticated request. A remote
 *   connection with no stored bearer therefore had one carried for it, which
 *   is what a device session is.
 *
 * `previousState` is the state being displaced, and it is load-bearing for the
 * case the delta review named: a LOOPBACK connection that was paired into a
 * device session must come back as `device-session`, not as the
 * `not-required` a bare loopback address would otherwise imply — the pairing
 * is a fact about the connection, not about the address.
 */
export function deriveCredentialState({
  hasStoredCredential,
  previousState,
  url,
  authenticatedRequestAccepted,
}: {
  hasStoredCredential: boolean;
  previousState: SavedConnection['credentialState'] | undefined;
  url: string;
  authenticatedRequestAccepted: boolean;
}): SavedConnection['credentialState'] {
  if (hasStoredCredential) return 'saved';
  if (previousState === 'device-session') return 'device-session';
  if (isLoopbackUrl(url)) return 'not-required';
  return authenticatedRequestAccepted ? 'device-session' : 'required';
}

function persistedEndpointsFor(
  connection: Partial<SavedConnection>,
): AccessEndpoint[] {
  return Array.isArray(connection.endpoints)
    ? connection.endpoints.filter(
        (endpoint): endpoint is AccessEndpoint =>
          endpoint?.endpointVersion === 1 &&
          typeof endpoint.id === 'string' &&
          typeof endpoint.url === 'string' &&
          typeof endpoint.priority === 'number',
      )
    : [];
}

function normalizeAccessMethod(
  method: EnvironmentAccessMethod,
  endpoints: readonly AccessEndpoint[],
): EnvironmentAccessMethod | null {
  if (method?.accessVersion !== 1 || typeof method.id !== 'string') return null;
  if (method.kind === 'direct-http') {
    const endpoint = endpoints.find(
      (candidate) => candidate.id === method.endpointId,
    );
    return endpoint ? createDirectHttpAccessMethod(endpoint) : null;
  }
  if (
    method.kind !== 'host-tunnel' ||
    method.adapter !== 'ssh' ||
    typeof method.hostAlias !== 'string' ||
    typeof method.remoteProjectPath !== 'string'
  ) {
    return null;
  }
  try {
    return createHostTunnelAccessMethod(method);
  } catch {
    return null;
  }
}

function persistedAccessMethodsFor(
  connection: Partial<SavedConnection>,
  endpoints: readonly AccessEndpoint[],
): EnvironmentAccessMethod[] {
  if (!Array.isArray(connection.accessMethods)) return [];
  return connection.accessMethods.flatMap((method) => {
    const normalized = normalizeAccessMethod(method, endpoints);
    return normalized ? [normalized] : [];
  });
}

type NormalizedAccessState = Pick<
  SavedConnection,
  | 'url'
  | 'endpoints'
  | 'selectedEndpointId'
  | 'accessMethods'
  | 'selectedAccessMethodId'
>;

function reconcileAccessState(
  connection: Partial<SavedConnection>,
  rawUrl: string,
  legacyEndpoint: AccessEndpoint,
): NormalizedAccessState {
  const persistedEndpoints = persistedEndpointsFor(connection);
  const persistedMethods = persistedAccessMethodsFor(
    connection,
    persistedEndpoints,
  );
  const hasHost = persistedMethods.some(
    (method) => method.kind === 'host-tunnel',
  );
  const endpoints = persistedEndpoints.length
    ? persistedEndpoints
    : hasHost && !rawUrl
      ? []
      : [legacyEndpoint];
  const selectedEndpoint =
    endpoints.find((item) => item.id === connection.selectedEndpointId) ??
    endpoints[0];
  const directMethods = endpoints.map(createDirectHttpAccessMethod);
  const hostMethods = persistedMethods.filter(
    (method) => method.kind === 'host-tunnel',
  );
  const accessMethods = [...hostMethods, ...directMethods];
  const selectedMethod =
    accessMethods.find(
      (method) => method.id === connection.selectedAccessMethodId,
    ) ??
    directMethods.find(
      (method) => method.endpointId === selectedEndpoint?.id,
    ) ??
    accessMethods[0];
  return {
    url: selectedEndpoint?.url ?? rawUrl,
    endpoints,
    selectedEndpointId: selectedEndpoint?.id ?? '',
    accessMethods,
    selectedAccessMethodId: selectedMethod?.id ?? '',
  };
}

/**
 * The stored displaced state, or nothing when the profile carries none — the
 * shape every profile written before #3599 has. Validated rather than trusted:
 * this value is fed straight back into `deriveCredentialState`, so a corrupt or
 * hand-edited store must not be able to name a credential state the connection
 * never had.
 */
function persistedDisplacedCredentialState(
  connection: Partial<SavedConnection>,
): SavedConnection['displacedCredentialState'] {
  const value = connection.displacedCredentialState;
  return value === 'not-required' ||
    value === 'saved' ||
    value === 'device-session'
    ? value
    : undefined;
}

function preservedProfileEvidence(
  connection: Partial<SavedConnection>,
): Partial<SavedConnection> {
  const displacedCredentialState =
    persistedDisplacedCredentialState(connection);
  return {
    ...(displacedCredentialState ? { displacedCredentialState } : {}),
    ...(connection.lastConnected === undefined
      ? {}
      : { lastConnected: connection.lastConnected }),
    ...(connection.lastSuccessAt === undefined
      ? {}
      : { lastSuccessAt: connection.lastSuccessAt }),
    ...(connection.lastBootId ? { lastBootId: connection.lastBootId } : {}),
    ...(connection.lastError ? { lastError: connection.lastError } : {}),
    ...(connection.lastTransition
      ? { lastTransition: connection.lastTransition }
      : {}),
    ...(connection.endpointCandidate
      ? { endpointCandidate: connection.endpointCandidate }
      : {}),
  };
}

export function normalizeConnectionProfile(
  connection: Partial<SavedConnection>,
  legacyEndpoint: AccessEndpoint,
  id: string,
): SavedConnection {
  const rawUrl = connection.url ?? '';
  const environmentId = connection.environmentId ?? null;
  return {
    profileVersion: 4,
    id,
    name: connection.name || rawUrl || 'Station',
    ...reconcileAccessState(connection, rawUrl, legacyEndpoint),
    environmentId,
    authProtocolVersion: connection.authProtocolVersion ?? null,
    // Native saved Stations carry the opaque OS-keyring reference selected
    // during pairing. Keep that reference intact rather than replacing it
    // with the Environment ID while normalizing the runtime projection.
    credentialRef: connection.credentialRef ?? {
      credentialVersion: 1,
      kind: environmentId ? 'environment' : 'connection',
      id: environmentId ?? id,
    },
    capabilities: connection.capabilities ?? null,
    credentialState:
      connection.credentialState ??
      (environmentId || isLoopbackUrl(connection.url)
        ? 'not-required'
        : 'required'),
    ...(connection.hostOwnedCredential === true
      ? { hostOwnedCredential: true as const }
      : {}),
    ...(typeof connection.ownerId === 'string' && connection.ownerId.length > 0
      ? { ownerId: connection.ownerId }
      : {}),
    ...preservedProfileEvidence(connection),
  };
}

export function mergeHostAccessProfiles(
  stable: SavedConnection,
  candidate: SavedConnection,
): SavedConnection | null {
  const hostMethods = candidate.accessMethods.filter(
    (method) => method.kind === 'host-tunnel',
  );
  if (!hostMethods.length) return null;
  const selected =
    hostMethods.find(
      (method) => method.id === candidate.selectedAccessMethodId,
    ) ?? hostMethods[0];
  return {
    ...stable,
    accessMethods: [
      ...stable.accessMethods.filter(
        (method) => !hostMethods.some((host) => host.id === method.id),
      ),
      ...hostMethods,
    ],
    selectedAccessMethodId: selected.id,
  };
}
