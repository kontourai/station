import type { SystemIdentityResponse } from '@kontourai/station-contracts/system-status';
import type { BundledServerStatus } from '../../platform/native/types';

export type EstablishedServerKind =
  | 'embedded-sidecar'
  | 'installed-local-service'
  | 'remote-server'
  | 'unresolved';

/**
 * The selected connection's facts this resolver may read, narrowed from
 * `SavedConnection`. Correlation never widens identity past these: an absent
 * fact yields `unresolved`, never a neighbouring classification.
 */
export interface ServerUpdateSelectionFacts {
  /** Host-projected owner (injected loopback or local-service profile). */
  ownerId?: string;
  sshForward?: { transport: 'ssh-forward' };
  selectedAccessIsDirectHttp: boolean;
}

export interface ConnectedServerCorrelationInput {
  /** The captured selection (and native binding) is still the live one. */
  scopeCurrent: boolean;
  /**
   * The captured native binding state still matches what the repository
   * reports for this exact connection and origin. For a host-secret injected
   * loopback there is no renderer binding to rotate, so "no binding, still
   * no binding" counts as current; a persisted connection must hold a live
   * binding or nothing here may claim its ownership.
   */
  nativeBindingCurrent: boolean;
  reachability: 'connected' | 'checking' | 'unavailable';
  identity: SystemIdentityResponse | null;
  isDesktop: boolean;
  nativeStatus: BundledServerStatus | null;
  apiBase: string;
  selection: ServerUpdateSelectionFacts | null;
}

function nonEmptyId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The selected connection claims this native owner (matching instance IDs on
 * both sides) — used to hold `unresolved` when that claim FAILS strict
 * correlation instead of falling through to the paired presentation.
 */
export function selectionClaimsNativeOwner(
  selection: ServerUpdateSelectionFacts | null,
  nativeStatus: BundledServerStatus | null,
): boolean {
  return Boolean(
    selection &&
      nonEmptyId(selection.ownerId) &&
      nonEmptyId(nativeStatus?.instanceId) &&
      selection.ownerId === nativeStatus.instanceId,
  );
}

/**
 * Parse a candidate endpoint strictly or refuse it. A query, fragment or
 * userinfo would rest the "same endpoint" claim on text a Station endpoint
 * never serves, so such shapes never participate in an identity match.
 */
function strictHttpUrl(value: string | null | undefined): URL | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return url;
}

/**
 * Exact endpoint equality. Hostnames compare as text — never through a DNS
 * alias equivalence — and both sides must be root paths on http(s).
 */
export function exactEndpointMatch(
  candidate: string | null | undefined,
  native: string | null | undefined,
): boolean {
  const left = strictHttpUrl(candidate);
  const right = strictHttpUrl(native);
  if (!left || !right) return false;
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.pathname === '/' &&
    right.pathname === '/'
  );
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API base points at exactly this loopback port. Loopback/port alone
 * never proves installed-service ownership — it only ever participates in
 * the full conjunction with the native binding, current native owner and
 * authenticated instance identity.
 */
export function exactLoopbackPortMatch(
  apiBase: string,
  port: number | null | undefined,
): boolean {
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535
  )
    return false;
  const url = strictHttpUrl(apiBase);
  if (!url) return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname) && url.port === String(port);
}

/** The exact sidecar child generation, absent outside a desktop-owned child. */
export function validSidecarGeneration(
  generation: number | null | undefined,
): boolean {
  return (
    typeof generation === 'number' &&
    Number.isInteger(generation) &&
    generation >= 0
  );
}

export function selectedAccessIsDirectHttp(connection: {
  accessMethods: ReadonlyArray<{ id: string; kind: string }>;
  selectedAccessMethodId: string;
}): boolean {
  return connection.accessMethods.some(
    (method) =>
      method.id === connection.selectedAccessMethodId &&
      method.kind === 'direct-http',
  );
}

/**
 * Correlate the selected connection with the native owner and the answering
 * server's authenticated identity, and name the established server kind.
 * Defaults to `unresolved`: missing facts on old clients/servers, a pending
 * binding or an incomplete identity are unknowns, not neighbouring kinds.
 */
export function resolveEstablishedServerKind(
  input: ConnectedServerCorrelationInput,
): EstablishedServerKind {
  const {
    scopeCurrent,
    nativeBindingCurrent,
    reachability,
    identity,
    isDesktop,
    nativeStatus,
    apiBase,
    selection,
  } = input;

  if (!scopeCurrent || reachability !== 'connected' || !identity) {
    return 'unresolved';
  }

  if (isDesktop && nativeBindingCurrent && nativeStatus && selection) {
    // Nonempty IDs on all three sides: two absent IDs are not equal evidence.
    const sameOwner =
      nonEmptyId(selection.ownerId) &&
      nonEmptyId(nativeStatus.instanceId) &&
      nonEmptyId(identity.instanceId) &&
      selection.ownerId === nativeStatus.instanceId &&
      identity.instanceId === nativeStatus.instanceId;

    if (
      nativeStatus.ownership === 'sidecar' &&
      nativeStatus.phase === 'running' &&
      !nativeStatus.failClosed &&
      sameOwner &&
      exactEndpointMatch(apiBase, nativeStatus.apiBase) &&
      validSidecarGeneration(nativeStatus.generation) &&
      nonEmptyId(nativeStatus.bootId) &&
      identity.bootId === nativeStatus.bootId
    ) {
      return 'embedded-sidecar';
    }

    if (
      nativeStatus.ownership === 'service' &&
      !nativeStatus.failClosed &&
      sameOwner &&
      selection.selectedAccessIsDirectHttp &&
      !selection.sshForward &&
      exactLoopbackPortMatch(apiBase, nativeStatus.port)
    ) {
      // The authenticated response supplies liveness. Native "stopped" means
      // Desktop has not attached; it is never evidence the service is down.
      return 'installed-local-service';
    }

    if (selectionClaimsNativeOwner(selection, nativeStatus)) {
      return 'unresolved';
    }
  }

  return identity.devicePresentation?.deviceClass === 'paired'
    ? 'remote-server'
    : 'unresolved';
}
