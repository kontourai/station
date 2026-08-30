export interface SavedConnection {
  profileVersion: 4;
  id: string;
  name: string;
  /** Compatibility alias for the selected endpoint URL. */
  url: string;
  endpoints: AccessEndpoint[];
  selectedEndpointId: string;
  accessMethods: EnvironmentAccessMethod[];
  selectedAccessMethodId: string;
  /** Server-owned identity learned from the public handshake. */
  environmentId: string | null;
  authProtocolVersion: number | null;
  credentialRef: CredentialRef;
  capabilities: EnvironmentCapabilities | null;
  credentialState: 'not-required' | 'required' | 'saved' | 'device-session';
  /**
   * The selected credential is held by the native host, never this renderer.
   * An authenticated native response may therefore restore a displaced
   * `saved` state without requiring a browser-visible bearer value.
   */
  hostOwnedCredential?: true;
  /**
   * The credential state a `required` displaced, so a recovery can put back
   * the fact that was lost rather than re-deriving it from the address: a
   * LOOPBACK connection paired into a device session must come back as
   * `device-session`, not as the `not-required` its address implies.
   *
   * Persisted with the rest of the profile because the recovery does not
   * always happen in the page that recorded the rejection — a reload between
   * the 401 and the accepted request would otherwise silently downgrade what
   * Connections reports about how this Station is reached (#3599). A profile
   * written before this field existed simply has none, which reads exactly as
   * "nothing was displaced" and derives from the address as it did before.
   *
   * `required` is excluded by construction: a rejection that finds the
   * connection already `required` displaces nothing and preserves whatever
   * the FIRST rejection recorded.
   */
  displacedCredentialState?: 'not-required' | 'saved' | 'device-session';
  endpointCandidate?: {
    url: string;
    state: 'unverified' | 'confirmation-required' | 'verification-failed';
  };
  lastConnected?: number;
  lastSuccessAt?: number;
  lastBootId?: string;
  lastError?: ConnectionFailure;
  lastTransition?: ConnectionFailure;
  /**
   * Host-injected connection (bundled-server loopback / CLI base). Held in the
   * store's non-persisted slot, so this marker never reaches storage; mutating
   * store operations (setCredential, markDeviceSession, reconcileHandshake)
   * no-op on it because it is not in the persisted list.
   */
  injected?: true;
  /** Source of the non-persisted injected slot; never serialized. */
  injectedSource?: InjectedConnection['source'];
  /**
   * Lifecycle state of the supervised bundled server behind a `managed-loopback`
   * injected connection. Present only for the desktop-supervised loopback (never
   * for a `cli-base` override, which is always reachable); lets the UI list the
   * local server with its current phase even when it is not `running` (and thus
   * has no URL). Never persisted — set only on the non-persisted injected slot.
   */
  injectedStatus?: InjectedConnectionStatus;
  /**
   * Host-owned local-service identity used only to fold the desktop's
   * injected owner into its matching saved profile. It is deliberately not an
   * endpoint key: distinct paired Stations may validly share an origin.
   */
  ownerId?: string;
  sshForward?: {
    transport: 'ssh-forward';
    launchId: string;
    provenance: {
      status: 'observed' | 'unobserved';
      sha?: string;
      channel?: string;
      capturedAt: string;
    };
  };
}

export interface DirectHttpAccessMethod {
  accessVersion: 1;
  id: string;
  kind: 'direct-http';
  endpointId: string;
}

/**
 * Credential-free reference resolved by a trusted host adapter. OpenSSH keys,
 * tokens, control paths, commands, and ephemeral forwarding URLs never belong
 * in this browser-safe profile.
 */
export interface HostTunnelAccessMethod {
  accessVersion: 1;
  id: string;
  kind: 'host-tunnel';
  adapter: 'ssh';
  hostAlias: string;
  remoteProjectPath: string;
}

export type EnvironmentAccessMethod =
  | DirectHttpAccessMethod
  | HostTunnelAccessMethod;

/** Transient adapter output. Persist the method, never the resolved endpoint. */
export interface ResolvedHostTunnelAccess {
  accessMethodId: string;
  endpoint: AccessEndpoint;
  hostIdentity: string;
  remoteProjectPath: string;
}

export type AccessEndpointKind =
  | 'same-origin'
  | 'tailnet-https'
  | 'lan-https'
  | 'lan-http'
  | 'managed-loopback'
  // A desktop-held `ssh -L` tunnel endpoint. The SDK's ssh-environment
  // adapter has emitted this kind at runtime since before it joined this
  // union — the union was lying about the runtime vocabulary.
  | 'ssh-forward'
  | 'manual';

/**
 * Lifecycle phase of a desktop-supervised bundled server, narrowed to the four
 * states worth surfacing on its injected connection. Derived from the native
 * host's richer status (starting/restarting collapse to `starting`,
 * stopping/stopped to `stopped`).
 */
export type InjectedConnectionStatus =
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopped';

/**
 * A host-supplied connection that never persists to storage. The native shell
 * injects the loopback base of the bundled Station server (`managed-loopback`)
 * or a CLI `--base` / `window.__API_BASE__` override (`cli-base`). It is
 * composed into the connection list at runtime, is non-removable and
 * non-editable, and resolves as the active connection when no saved connection
 * is explicitly active.
 *
 * On a supervising desktop the `managed-loopback` connection is always present
 * so the user can see the local server and its state; its `url` is set only
 * while the server is `running` (a not-running server has no base to talk to,
 * so it is listed but never auto-selected as the active connection). `status`
 * carries that lifecycle state for display; a `cli-base` override is always
 * reachable and omits it.
 */
export interface InjectedConnection {
  id: string;
  name: string;
  /** Present only when reachable: a `running` bundled server, or a CLI base. */
  url?: string;
  source: 'managed-loopback' | 'cli-base' | 'mobile-default';
  /** Bundled-server lifecycle state; set for `managed-loopback` only. */
  status?: InjectedConnectionStatus;
  /** Current host-reported local-service identity, when one is available. */
  ownerId?: string;
}

export interface AccessEndpoint {
  endpointVersion: 1;
  id: string;
  url: string;
  kind: AccessEndpointKind;
  priority: number;
  verifiedAt?: number;
}

/** A lookup reference only. Bearer material is held by a separate adapter. */
export interface CredentialRef {
  credentialVersion: 1;
  kind: 'environment' | 'connection';
  id: string;
}

export interface EnvironmentCapabilities {
  capabilityVersion: number;
  sessionIndex: boolean;
  eventStream: boolean;
}

export type ConnectionFailureReason =
  | 'offline'
  | 'mixed-content'
  | 'invalid-endpoint'
  | 'identity-mismatch'
  | 'access-method-mismatch'
  | 'authentication-failed'
  | 'unsupported-capability-version'
  | 'timeout'
  /**
   * Nothing answered: a thrown fetch (DNS failure, refused socket, no route).
   * This reason names a NETWORK condition, so nothing may resolve to it
   * without having observed one — station#3297. An HTTP response of any
   * status is proof the address answered and therefore disqualifies it.
   */
  | 'unreachable'
  | 'server-restarted'
  /**
   * Station's own UI proxy answered its documented unavailable envelope while
   * the sibling server process was down or still recovering. This is neither
   * a network failure nor evidence that a foreign server owns the address.
   */
  | 'host-unavailable'
  /**
   * station#3297 — the host answered and refused this app's web address
   * (`origin_forbidden` / `origin_required`). Deliberately NOT
   * `authentication-failed`: no credential this device can obtain changes
   * the answer, so offering to pair again would send the reader at a fix
   * that cannot work. The remedy is on the host's allow-list.
   */
  | 'origin-not-allowed'
  /**
   * station#3297 — an HTTP response arrived that this client cannot use as a
   * Station: a status it cannot attribute (404, 5xx, an uncoded 403), or a
   * handshake body that is not readable JSON. All that is derived is "the
   * address answered, and not as a Station" — never that it is unreachable
   * (it demonstrably is not) and never that a credential is at fault.
   */
  | 'unexpected-response'
  /**
   * station#3297 — the check failed and did not say why. The one honest
   * reading of a bare `false` from a boolean `checkHealth`, of a probe that
   * threw something unrecognized, and of a run that had no endpoint to
   * attempt. Before this existed those all resolved to `unreachable`, which
   * is a network claim derived from nothing: the label the issue exists to
   * remove. Never assert a cause here — the retry ladder keeps running and
   * a later probe usually produces a real reason.
   */
  | 'undetermined'
  /**
   * station#1713 — a healthy host that is simply waiting on a human to
   * approve this device (a native Station mid-authorization, or an access
   * request nothing has confirmed yet). Deliberately excluded from
   * `FAILURE_COPY`/`connectionFailureCopy` (`environmentProfiles.ts`): a
   * caller must recognize and route around this reason before ever asking
   * for failure copy, because it is never a failure to explain — it is the
   * ordinary shape of "still waiting", and rendering it as one is the exact
   * miscategorization that cost hours of debugging (station#1713).
   */
  | 'awaiting-approval';

export interface ConnectionFailure {
  reason: ConnectionFailureReason;
  endpointId?: string;
  at: number;
  detail?: string;
}

export type EnvironmentConnectionState =
  | { phase: 'idle' }
  | { phase: 'connecting'; attempt: number; endpointId: string }
  | {
      phase: 'connected';
      endpointId: string;
      accessMethodId?: string;
      connectedAt: number;
    }
  | {
      phase: 'stale';
      readOnly: true;
      lastSuccessAt: number;
      failure: ConnectionFailure;
    }
  | { phase: 'error'; failure: ConnectionFailure };

export interface StationHandshakeIdentity {
  schemaVersion?: number;
  environmentId: string;
  authentication: {
    scheme: 'bearer';
    protocolVersion: number;
  };
  transports?: {
    http: number;
    sse: number;
    websocket: number;
  };
}

/** Pull-based so credential material never becomes renderable React state. */
export interface ConnectionCredentialProvider {
  getCredential(): string | undefined;
  getProtocolVersion(): number | undefined;
}

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type ConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'error'
  // Neutral/at-rest: used for a supervised local server that is deliberately
  // stopped (not an error, not connecting).
  | 'idle';

export type ConnectionCandidateSource =
  | 'lan-dns-sd'
  | 'tailnet'
  | 'desktop-host';

/**
 * A secret-free reachability hint from a host-owned provider. Candidates are
 * never trusted identities: the public Station handshake and pairing boundary
 * still decide whether an environment may be saved or used.
 */
export interface ConnectionCandidate {
  candidateVersion: 1;
  id: string;
  name: string;
  url: string;
  source: ConnectionCandidateSource;
  providerId: string;
  discoveredAt: number;
}

export interface ConnectionCandidateProviderContext {
  signal: AbortSignal;
}

/** Native shells and trusted host adapters register providers at runtime. */
export interface ConnectionCandidateProvider {
  id: string;
  discover(
    context: ConnectionCandidateProviderContext,
  ): Promise<readonly Omit<ConnectionCandidate, 'id' | 'providerId'>[]>;
}

/** @deprecated Use ConnectionCandidate from a registered provider. */
export interface DiscoveredServer {
  url: string;
  name: string;
  latency: number;
}
