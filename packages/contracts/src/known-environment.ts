/**
 * Unified client-side "environments I know how to reach" model
 * (station#1096 — fleet-model cornerstone).
 *
 * Three previously disconnected mechanisms describe the same underlying
 * concept — a Station server this client can talk to — under three
 * different shapes:
 *   - device-paired origins (`packages/connect`'s `SavedConnection`, keyed
 *     by a browser-local id, endpoints resolved via the well-known
 *     handshake);
 *   - the shared CLI/Desktop saved Station store (`StationProfile`,
 *     profile name → endpoint with optional Environment identity);
 *   - SSH environment profiles (`SshEnvironmentProfile`,
 *     `packages/sdk/src/query-domains/sshEnvironments.ts`, agent-delegation
 *     targets reached over an SSH-forwarded local port).
 *
 * `KnownEnvironment` is the read/reference model those three project onto
 * (or persist into, for genuinely new entries) so a single UI surface (the
 * Connections hub, station#1096 R4) and a single CLI concept (`station
 * profile`, R3) can reason about "the stations I know about" without caring
 * which mechanism first learned about one.
 *
 * Deliberately NOT modeled here: LAUNCH. How a server comes to exist (e.g.
 * an SSH bootstrap that starts a Station process on a remote machine) is a
 * separate concern from ACCESS (a URL this client can reach it at). An SSH
 * profile contributes an endpoint + the `'ssh'` source tag to this model;
 * it does not make `KnownEnvironment` own the bootstrap lifecycle.
 *
 * Deliberately NOT modeled here: secrets. No bearer credential, device
 * proof, or SSH key material belongs on this type or in any registry built
 * on top of it — credentials stay in their existing mechanism-specific,
 * origin/environment-keyed stores (`packages/connect`'s credential
 * `StorageAdapter`, the platform profile credential store). A `KnownEnvironment`
 * is safe to log, serialize, and display without redaction.
 *
 * Naming note: this file's `AccessEndpoint` is a different, narrower type
 * from `packages/connect`'s `AccessEndpoint` (`SavedConnection.endpoints`,
 * `endpointVersion: 1`, `kind: AccessEndpointKind` with
 * `'same-origin'|'tailnet-https'|...`). That one is the richer,
 * reconnect-state-tracking model backing the device-pairing UI's own
 * persistence; this one is the smaller, cross-mechanism read model. Do not
 * conflate the two — `packages/connect` intentionally keeps its own type
 * name and does not re-export this one under the same identifier.
 */

export const KNOWN_ENVIRONMENT_SCHEMA_VERSION = 1 as const;

/**
 * Which mechanism first taught this client about the environment. Purely
 * descriptive (drives the Connections hub's source badge) — it never gates
 * behavior, and an environment keeps its original source even after a
 * handshake attaches its `environmentId`.
 */
export type KnownEnvironmentSource = 'manual' | 'ssh' | 'paired' | 'discovered';

/**
 * How this specific endpoint reaches the environment.
 *  - `direct`: a plain HTTP(S) base URL (manual entry, paired origin, CLI
 *    host, LAN/tailnet address).
 *  - `ssh-forward`: a local port forwarded over SSH to a remote Station or
 *    delegated worker (SSH environment profiles; `packages/connect`'s
 *    host-tunnel access method).
 *  - `discovered`: surfaced by a reachability provider (LAN mDNS, tailnet
 *    listing) but not yet confirmed by a handshake.
 */
export type AccessEndpointKind = 'direct' | 'ssh-forward' | 'discovered';

export interface AccessEndpoint {
  /** Stable within one `KnownEnvironment`; not globally unique. */
  id: string;
  /** Always a bare origin (`https://host:port`), never a path. */
  httpBaseUrl: string;
  kind: AccessEndpointKind;
  /** At most one endpoint per environment should be marked preferred. */
  preferred?: boolean;
  addedAt: number;
  /** Epoch ms of the last successful well-known handshake through this endpoint. */
  lastVerifiedAt?: number;
}

export interface KnownEnvironment {
  schemaVersion: typeof KNOWN_ENVIRONMENT_SCHEMA_VERSION;
  /**
   * Stable local identity, assigned when the entry is first created and
   * never reassigned — including across an `environmentId` attach/merge,
   * so callers holding this id never get silently invalidated by a
   * handshake. Only a genuine identity-merge (two entries turning out to
   * be the same `environmentId`) retires the losing entry's id.
   */
  id: string;
  /**
   * Server-owned identity, attached after the FIRST successful well-known
   * handshake (`GET /.well-known/station/v1`) through any endpoint on this
   * entry. Absent for an entry that has never been reached yet.
   */
  environmentId?: string;
  label: string;
  source: KnownEnvironmentSource;
  endpoints: AccessEndpoint[];
  createdAt: number;
  updatedAt: number;
}
