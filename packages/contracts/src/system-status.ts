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
 * What a service-update request asks the service to do (#3851 slice 4):
 * - `stage`: download and verify the release into the install, then stop.
 *   The running server keeps running; the outcome is `staged`.
 * - `apply`: hand an already staged version to the launcher's trial. Never
 *   downloads; refused when the version is not staged.
 * - `update`: both, in one request (the #2675 behavior, and what a request
 *   with no intent means: `station upgrade` and clients older than #3851).
 */
export type ServiceUpdateIntent = 'stage' | 'apply' | 'update';

/**
 * The step of staging the running version's installer reports (#3851). Only
 * install.sh reports them; install.ps1 does not yet, so a Windows service's
 * `staging` carries no phase.
 * - `downloading`: fetching the release archive; byte counts ride beside it.
 * - `verifying`: checking the archive's size, SHA-256 and contents.
 * - `installing`: extracting, self-checking and sealing the version.
 */
export type ServiceStagePhase = 'downloading' | 'verifying' | 'installing';

/**
 * The service launcher's update progress for a prebuilt-archive install
 * (#2675 slice D), as `GET /api/system/core-update/service-update` reads it
 * from the install's runtime files. Each state names what a file says, never
 * a guess:
 * - `idle`: no request queued and no update ever recorded.
 * - `queued`: the server wrote the request; the service has not claimed it.
 * - `staging`: the running version claimed it and is downloading and
 *   verifying the release (its install.sh, stage-only). `stagePhase`, and
 *   while downloading `downloadedBytes` (measured on disk) of `totalBytes`
 *   (the signed manifest's size), are present when the installer reported
 *   them (#3851); absent on older servers and on Windows.
 * - `staged` (#3851): a `stage` request finished; `version` is downloaded,
 *   verified and complete in the install, and nothing restarted. Reported
 *   only while that version's completion sentinel is still on disk.
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
 *
 * Compatibility (#3851): every addition is optional or a new state. A client
 * older than #3851 ignores `intent` and the staging fields, and renders no
 * line for `staged` (its switch has no case for it); it still offers its
 * one-click update, whose request (no intent) finds the staged version and
 * trials it without downloading again.
 */
export type ServiceUpdateProgress =
  | { state: 'idle' | 'unavailable' }
  | { state: 'queued'; requestId: string; intent?: ServiceUpdateIntent }
  | {
      state: 'staging';
      requestId: string;
      intent?: ServiceUpdateIntent;
      stagePhase?: ServiceStagePhase;
      downloadedBytes?: number;
      totalBytes?: number;
    }
  | { state: 'staged'; requestId: string; version: string; stagedAt: string }
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

/**
 * When a launcher-run server downloads an available update by itself
 * (#3851): `never`, once it has been available for 24 hours, or as soon as
 * a check finds it. Downloading never restarts the server; only an explicit
 * apply (or apply-when-idle) does.
 */
export type ServerUpdateDownloadPolicy = 'never' | 'after-24h' | 'immediately';

export const SERVER_UPDATE_DOWNLOAD_POLICIES: readonly ServerUpdateDownloadPolicy[] =
  ['never', 'after-24h', 'immediately'];

export const DEFAULT_SERVER_UPDATE_DOWNLOAD_POLICY: ServerUpdateDownloadPolicy =
  'after-24h';

/**
 * The server's own view of its update (#3851 slice 4), served by
 * `GET /api/system/core-update/state` and pushed to every client as the
 * `server-update:changed` event. Every field is computed by the answering
 * server:
 * - `supported`: the fixed service launcher runs this server, so it can
 *   stage and apply updates to itself. When false, every other field is at
 *   its empty value and clients use `GET /api/system/core-update`.
 * - `availability`: the last release check this server made (on boot, when
 *   a client newer than it connected, or a client's check), null before one.
 *   `availableSince` is when a check first saw `latestVersion` as newer.
 * - `progress`: the same record `GET /core-update/service-update` reads.
 * - `autoDownloadAt`: when `downloadPolicy` will stage `latestVersion` by
 *   itself; null when it will not (policy `never`, nothing available, or
 *   already staged or under way). It is evaluated on a check, not by a
 *   clock: a server checks again when it is due.
 * - `applyWhenIdle`: a persisted request to apply `version` once no agent
 *   turn is running; null when none is set. `waitingForTurns` is how many
 *   running turns its last evaluation found (absent before one ran): a turn
 *   that never ends keeps it waiting, and this is where that shows.
 * - `autoDownloadPausedReason`: why the policy is not downloading the
 *   available release: `update-failed` (its update rolled back or failed;
 *   until a person's Download or a newer release) or `download-failed` (it
 *   is retried at `autoDownloadAt`). Optional: absent on servers before it.
 */
// A type alias, not an interface: it is an event payload
// (`Record<string, unknown>`), which an interface is not assignable to.
export type ServerUpdateState = {
  supported: boolean;
  currentVersion: string | null;
  availability: {
    checkedAt: string;
    releaseCheck: 'verified' | 'unreachable' | 'unverified' | 'not-recorded';
    latestVersion: string | null;
    updateAvailable: boolean;
    availableSince: string | null;
  } | null;
  progress: ServiceUpdateProgress;
  downloadPolicy: ServerUpdateDownloadPolicy;
  autoDownloadAt: string | null;
  autoDownloadPausedReason?: 'update-failed' | 'download-failed' | null;
  applyWhenIdle: {
    version: string;
    requestedAt: string;
    waitingForTurns?: number;
  } | null;
};

/**
 * An agent turn running on this server right now: what a restart would
 * interrupt (#3851). Only sessions the caller may read are listed;
 * `hiddenCount` counts the running turns it may not. Nothing here says a
 * turn will resume after a restart: nothing computes that yet.
 */
export interface ServerUpdateRunningTurn {
  sessionId: string;
  conversationId: string | null;
  title: string | null;
  /** The engine (provider) id running the turn. */
  engine: string;
  startedAt: string | null;
}

export interface ServerUpdateRunningTurns {
  turns: ServerUpdateRunningTurn[];
  hiddenCount: number;
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
