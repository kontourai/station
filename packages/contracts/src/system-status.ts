import type { EngineConnectionId, EngineId } from './agent-identity.js';

/** Point-in-time resources on the answering Station host, not the viewing device. */
export interface HostResourceSnapshot {
  sampledAt: number;
  memory: { totalBytes: number; freeBytes: number };
  process: {
    pid: number;
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
}

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

/**
 * The answering server's process/build identity: which Station instance, which
 * boot of it, built from which commit. All three fields are required for the
 * identity to be an identity — a partial answer must be reported as
 * unavailable, never served as one. `shaSource` names what computed `sha`: a
 * checkout-derived value must not read as the build's identity.
 */
export interface SystemRuntimeIdentity {
  instanceId: string;
  bootId: string;
  sha: string;
  shaSource?: 'build-stamp' | 'checkout';
}

/**
 * The `GET /api/system/identity` response. `devicePresentation` is the same
 * request-bound projection `/api/system/status` serves, repeated here so an
 * identity probe can present host-hands affordances without a second status
 * request; optional because servers older than that projection omit it.
 */
export interface SystemIdentityResponse extends SystemRuntimeIdentity {
  /** Optional for compatibility with older servers. */
  devicePresentation?: DevicePresentation;
}

/** Why an install could not state what it is (update provenance diagnostics). */
export type UpdateProvenanceIssue = 'missing' | 'invalid-stamp';

/**
 * Why this server refuses to apply an update to itself, as a code a client can
 * gate on, each naming what the server actually observed:
 * - `service-managed`: the launchd/systemd unit's marker is set — the
 *   installed Station service restarts this process on exit.
 * - `supervised`: only a supervisor PID is set — some supervisor (the Windows
 *   service, the desktop, a dev harness) owns this process's lifecycle.
 * Either way an in-place pull-rebuild-restart would fight that supervisor.
 * The human remedy travels beside it in `selfUpdateUnavailableReason`.
 */
export type SelfUpdateUnavailableCode = 'service-managed' | 'supervised';

/** Where a launcher-run update transaction is while it is unfinished. */
export type ServiceUpdatePhase =
  | 'stopping'
  | 'backing-up'
  | 'trial'
  | 'restoring';

/**
 * The service launcher's update progress for a prebuilt-archive install
 * (#2675 slice D), as `GET /api/system/core-update/service-update` reads it
 * from the install's runtime files. Each state names what a file says, never
 * a guess:
 * - `idle`: no request queued and no update ever recorded.
 * - `queued`: the server wrote the request; the service has not claimed it.
 * - `staging`: the running version claimed it and is downloading and
 *   verifying the release (its install.sh, stage-only).
 * - `updating`: the launcher accepted a version and is in `phase`.
 * - `committed`: the launcher now runs `targetVersion`.
 * - `rolled-back` / `failed`: the launcher kept (or returned to)
 *   `fromVersion`; `reason` is the launcher's code (e.g. `prepared-timeout`,
 *   `candidate-exited:1`, `backup-failed`).
 * - `needs-operator`: the launcher could not restore the home to roll the
 *   update back, `restoreAttempts` times; it keeps the backup, runs no
 *   version, and retries once each time the service is stopped and started.
 * - `up-to-date`: staging found nothing newer than `version`.
 * - `staging-failed` / `rejected`: the request ended before any trial;
 *   `reason` is the staging failure or the launcher's refusal.
 * - `unavailable`: a runtime file exists but cannot be read.
 * `requestId` correlates the outcome with the request an apply (or `station
 * upgrade`) wrote; null when the launcher's record carries none.
 */
export type ServiceUpdateProgress =
  | { state: 'idle' | 'unavailable' }
  | { state: 'queued' | 'staging'; requestId: string }
  | {
      state: 'updating';
      requestId: string | null;
      phase: ServiceUpdatePhase;
      fromVersion: string;
      targetVersion: string;
      attempts: number;
    }
  | {
      state: 'committed';
      requestId: string | null;
      fromVersion: string;
      targetVersion: string;
      finishedAt: string;
    }
  | {
      state: 'rolled-back' | 'failed';
      requestId: string | null;
      fromVersion: string;
      targetVersion: string;
      reason: string;
      finishedAt: string;
    }
  | {
      state: 'needs-operator';
      requestId: string | null;
      fromVersion: string;
      targetVersion: string;
      reason: string;
      restoreAttempts: number;
      finishedAt: string;
    }
  | {
      state: 'up-to-date';
      requestId: string;
      version: string;
      finishedAt: string;
    }
  | {
      state: 'staging-failed' | 'rejected';
      requestId: string;
      reason: string;
      finishedAt: string;
    };

/** Disclosure from this home, not a certificate of transferred execution authority. */
export type HomeRecoveryDisclosure =
  | { kind: 'not-restored' | 'unavailable' }
  | {
      kind: 'recovered-from-copy';
      recoveryId: string;
      snapshotCreatedAt: string;
      authorityTransferred: false;
    };
