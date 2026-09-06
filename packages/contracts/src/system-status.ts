import type { EngineConnectionId, EngineId } from './agent-identity.js';

/** One external engine's readiness and optional public navigation identity. */
export interface ExternalEngineReadinessProjection {
  engineId: EngineId;
  name: string;
  engineConnectionId?: EngineConnectionId;
  /**
   * Registry entry Station can connect on the host after the user chooses it.
   * Present only for a detected, not-yet-connected Engine; it is not a
   * connection identity and must not be used as one before installation.
   */
  registryEntryId?: string;
  detected: boolean;
  ready: boolean;
  source: string | null;
  reason?:
    | 'sign_in_required'
    | 'missing_prerequisites'
    | 'cannot_verify'
    | 'disabled'
    | 'not_connected';
}

/**
 * Which machine the person reading this screen is sitting at.
 *
 * `host` — the request's credential proved possession of Station's home
 * directory, so the browser is on the machine Station runs on.
 * `paired` — every other authorized principal: a phone, a laptop on the
 * LAN, a tailnet browser. A paired device is a remote control for the host,
 * not a second host, so an affordance that executes on the host's machine
 * must name that machine rather than present itself as local.
 */
export type DeviceClass = 'host' | 'paired';

/**
 * The one projection every surface reads before deciding how to present an
 * affordance that runs on the host's machine (station#3843 §1).
 *
 * `deviceClass` is derived from the SAME locality fact D6 established
 * (`principal.locality === 'home-possession'`, bound once per request by the
 * auth boundary). There is deliberately no second predicate: no socket
 * check, no proxy stamp, no credential-kind branch, and no client heuristic.
 * A surface must never derive it from viewport size either — a phone plugged
 * into the host is still `host`, and a desktop browser on another machine is
 * `paired`.
 */
export interface DevicePresentation {
  deviceClass: DeviceClass;
  /** What the host machine calls itself. Never guessed from the request. */
  hostName: string;
}

/** Disclosure from this home, not a certificate of transferred execution authority. */
export type HomeRecoveryDisclosure =
  | { kind: 'not-restored' | 'unavailable' }
  | {
      kind: 'recovered-from-copy';
      recoveryId: string;
      snapshotCreatedAt: string;
      authorityTransferred: false;
    };
