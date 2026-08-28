/**
 * Read-adapter: paired/manual `SavedConnection`s (`@kontourai/station-connect`)
 * → the unified `KnownEnvironment` model (archive#1096). Pure projection,
 * mirroring `packages/sdk/src/query-domains/knownEnvironments.ts`'s SSH
 * adapter — this module never writes to `ConnectionStore`; the device-pairing
 * mechanism stays the source of truth for credentials, reconnect state, and
 * its own richer endpoint-candidate/access-method persistence.
 *
 * Source classification: a connection whose only access method is an SSH
 * host-tunnel is tagged `'ssh'` (it is reached the same way an SSH
 * environment profile is — a forwarded local port, no persisted direct
 * endpoint). Every other saved connection is tagged `'paired'`: this is a
 * disclosed simplification (a connection added by manually typing a URL and
 * one added via QR/device-pairing exchange both persist as `SavedConnection`
 * with no distinguishing field once saved), acceptable because the
 * predominant use of `packages/connect`'s store is the device-pairing flow —
 * see the PR description for the full rationale.
 */
import type { SavedConnection } from '@kontourai/station-connect';
import { normalizeBaseUrl } from '@kontourai/station-connect/known-environment';
import type {
  AccessEndpoint,
  KnownEnvironment,
} from '@kontourai/station-contracts';
import { KNOWN_ENVIRONMENT_SCHEMA_VERSION } from '@kontourai/station-contracts';

/**
 * Host-injected connections (bundled-server loopback, CLI base override) are
 * ephemeral, non-removable, and never persisted — they describe how THIS
 * browser tab is currently reaching a station, not a station the user
 * manages. They are excluded from the unified list.
 */
export function savedConnectionToKnownEnvironment(
  connection: SavedConnection,
): KnownEnvironment | null {
  if (connection.injected) return null;
  const hasHostTunnel = connection.accessMethods.some(
    (method) => method.kind === 'host-tunnel',
  );
  const now =
    connection.lastConnected ?? connection.lastSuccessAt ?? Date.now();
  const endpoints: AccessEndpoint[] = connection.endpoints.map((endpoint) => ({
    id: endpoint.id,
    httpBaseUrl: normalizeBaseUrl(endpoint.url),
    kind: 'direct',
    preferred: endpoint.id === connection.selectedEndpointId,
    addedAt: now,
    ...(endpoint.verifiedAt !== undefined
      ? { lastVerifiedAt: endpoint.verifiedAt }
      : {}),
  }));
  return {
    schemaVersion: KNOWN_ENVIRONMENT_SCHEMA_VERSION,
    id: `paired:${connection.id}`,
    ...(connection.environmentId
      ? { environmentId: connection.environmentId }
      : {}),
    label: connection.name,
    source: hasHostTunnel ? 'ssh' : 'paired',
    endpoints,
    createdAt: now,
    updatedAt: connection.lastSuccessAt ?? now,
  };
}

export function savedConnectionsToKnownEnvironments(
  connections: readonly SavedConnection[],
): KnownEnvironment[] {
  return connections
    .map(savedConnectionToKnownEnvironment)
    .filter(
      (environment): environment is KnownEnvironment => environment !== null,
    );
}

/**
 * True when a saved connection can actually be used to control the Station
 * it points at right now — archive#1134 1 : a connection
 * can be `saved` (present in `ConnectionStore`) without ever having
 * completed authorization, e.g. the user cancelled
 * `ConnectionManagerModalContent`'s authorize panel, leaving
 * `credentialState: 'required'`. `savedConnectionToKnownEnvironment` above
 * intentionally never carries `credentialState` onto `KnownEnvironment` (this
 * file stays a pure projection, and `KnownEnvironment` is documented as
 * "safe to log, serialize, and display" with no mechanism-specific state) —
 * so the Stations-list UI needs this side lookup instead of inferring
 * control from `source: 'paired'` alone, which was the exact class of
 * unevidenced claim archive#1116's review fixed for the source badge.
 *
 * `'not-required'` means access is managed outside this projection; it never
 * infers protected-route authority from a loopback/same-origin address.
 * `'saved'`/`'device-session'` mean a working credential already exists. Only
 * `'required'` (never authorized, or a credential that was removed) or the
 * most recent attempt having failed with `authentication-failed` count as NOT
 * yet able to control the target.
 */
export function isPairedConnectionAuthorized(
  connection: SavedConnection,
): boolean {
  if (connection.lastError?.reason === 'authentication-failed') return false;
  return connection.credentialState !== 'required';
}

export interface PairedAuthorizationLookup {
/** Keyed by the raw `SavedConnection.id` (matches a standalone, not-yet-merged `paired:<id>` `KnownEnvironment.id`). */
  byConnectionId: ReadonlyMap<string, boolean>;
/** Keyed by the connection's own learned `environmentId`, when set (matches a merged card whose winning identity came from elsewhere — the SSH profile, or a manual entry that handshaked first). */
  byEnvironmentId: ReadonlyMap<string, boolean>;
}

export function pairedAuthorizationByConnection(
  connections: readonly SavedConnection[],
): PairedAuthorizationLookup {
  const byConnectionId = new Map<string, boolean>();
  const byEnvironmentId = new Map<string, boolean>();
  for (const connection of connections) {
    if (connection.injected) continue;
    const authorized = isPairedConnectionAuthorized(connection);
    byConnectionId.set(connection.id, authorized);
    if (connection.environmentId) {
      byEnvironmentId.set(connection.environmentId, authorized);
    }
  }
  return { byConnectionId, byEnvironmentId };
}
