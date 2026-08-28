/**
 * Single source of truth for the boolean feature flags Station's public
 * handshake (`GET /.well-known/station/v1`, `PublicStationHandshake.
 * capabilities`) advertises — archive#1095, the rolling-upgrade
 * feature-detection story for phone/CLI vs server skew. See
 * `packages/contracts/src/environment-security.ts`'s
 * `StationCapabilityFlags` doc comment for the full contract (every key
 * optional, absence means unsupported, and why this is unrelated to
 * `StationCompatibility.capabilities` or `packages/connect`'s
 * `EnvironmentCapabilities`).
 *
 * `EnvironmentSecurityService#getPublicHandshake` spreads this object
 * verbatim onto the handshake response — a sibling PR adds a new flag with
 * a one-line change here (plus mirroring the key on `StationCapabilityFlags`
 * for type safety) and does not need to touch the route handler or the
 * service.
 */
import type { StationCapabilityFlags } from '@kontourai/station-contracts';

export const STATION_CAPABILITY_FLAGS: Readonly<StationCapabilityFlags> = {
  // SSH environment management: src-server/services/ssh/, /api/ssh-environments
  // routes, packages/sdk/src/query-domains/sshEnvironments.ts.
  sshEnvironments: true,
  // Web Push subscribe/unsubscribe: src-server/routes/operations/push-routes.ts.
  webPushNotifications: true,
  // Sequence-cursor resume for the orchestration event stream (archive#1092):
  // src-server/routes/orchestration/orchestration.ts `/events`. Server-side
  // resume handling is unconditional (harmless to old clients), so this is
  // always true rather than gated on any runtime config.
  eventStreamResume: true,
  // Versioned, bounded history windows for a single orchestration session.
  sessionEventWindow: true,
  // Scoped pairing (archive#1098): pairing grants/device sessions carry an
  // OAuth-style scope string, enforced by one route -> required-scope table.
  // src-server/security/pairing-route-scopes.ts,
  // src-server/services/ssh/device-pairing-service.ts.
  scopedPairing: true,
  // Fleet inference (archive#1398): "this build understands the
  // `inference:invoke` pairing-scope token" (docs/design/inference-fleet.md
  // §3.3 point 2). A STATIC PROTOCOL FACT, never a participation signal —
  // the handshake is public and unauthenticated, so a flag derived from
  // whether this Station currently contributes models would let any LAN or
  // tailnet scanner enumerate which of the owner's machines have GPUs
  // (§5.2 rule 1). Whether anything is actually contributed is readable
  // only after authentication, from `GET /api/inference/manifest`.
  //
  // Advertised now because it is finally true: `PAIRING_SCOPES` contains
  // the token, so a peer that trusts this flag and mints
  // `"orchestration:read inference:invoke"` against this build has its
  // grant parsed rather than refused outright. Slice 1 deliberately left it
  // absent for the inverse reason.
  //
  // The safety property that made the flip possible is the decoupling in
  // the same slice: `DEFAULT_GRANT_PAIRING_SCOPE` is no longer
  // `PAIRING_SCOPES.join(' ')` but a frozen four-token constant, so
  // widening the vocabulary neither granted `inference:invoke` to the three
  // populations that receive the default grant nor changed the bytes an
  // older peer has to parse.
  //
  // The if-and-only-if coupling is pinned by
  // `station-capability-flags.test.ts`: the flag cannot be advertised
  // without the token, and the token cannot be removed without the flag.
  fleetInference: true,
};
