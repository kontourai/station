/**
 * The server's own update lifecycle for a launcher-run archive service
 * (#3851 slice 4): when it checks for a release, when it downloads one by
 * itself, when it applies one because nothing is running, and what it tells
 * every client about all of that.
 *
 * Nothing here runs on a schedule (owner preference: no standing product
 * loops). Every action follows an event:
 * - a check: once, shortly after boot, and when a client newer than this
 *   server connects. A cached result younger than `checkTtlMs` answers a
 *   repeated trigger without refetching. A client's own check (`GET
 *   /core-update`, which always fetches) refreshes the cache and the
 *   availability record but never runs the policy.
 * - an automatic download: evaluated after the coordinator's own checks and
 *   when the policy setting itself changes. When the policy's delay has not
 *   passed yet, ONE timer is armed for the moment it does (at most
 *   `MAX_TIMER_MS` ahead, then re-armed), and it runs one more check. That is
 *   a deadline for a known event, not a poll. The policy downloads a given
 *   version once: a version whose download it already started, or whose
 *   update was rolled back or failed, is left to a person's Download until a
 *   newer one appears. Nor does it download while an apply-when-idle intent
 *   waits for the staged version.
 * - apply-when-idle: evaluated once the server is ready
 *   (`markReady`, after listening and turn recovery), when the intent is
 *   set, and while it is set, at most every `idleDebounceMs` while runtime
 *   events flow. The decision reads every session's active-turn state
 *   (ephemeral ones included). Accepted gap: a turn that starts between that
 *   read and the launcher stopping the server is interrupted; nothing gates
 *   new turns while the restart is being requested.
 * - progress: while a request this server can see is queued or staging, the
 *   runtime files the service child writes are read once a second and every
 *   change is pushed; it stops as soon as the request leaves those states.
 *
 * Downloading never restarts the server. Only `apply` (a person's Restart)
 * or the apply-when-idle intent a person set does.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SERVER_EVENTS } from "@kontourai/station-contracts/runtime-events";
import {
  DEFAULT_SERVER_UPDATE_DOWNLOAD_POLICY,
  SERVER_UPDATE_DOWNLOAD_POLICIES,
  type ServerUpdateDownloadPolicy,
  type ServerUpdateState,
  type ServiceUpdateProgress,
} from "@kontourai/station-contracts/system-status";
import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
} from "@kontourai/station-shared/release-version-order";
import {
  readServiceUpdateProgress,
  serviceUpdatePaths,
  writeJsonAtomically,
} from "@kontourai/station-shared/service-launcher-protocol";
import {
  type ArchiveApplyResult,
  type ArchiveUpdateOptions,
  type ArchiveUpdateStatus,
  applyArchiveUpdate,
  applyStagedServerUpdate,
  archiveApplyMethod,
  archiveUpdateStatus,
} from "../../routes/system/archive-update.js";
import type { InstallProvenance } from "../../routes/system/install-provenance.js";

type ArchiveProvenance = Extract<InstallProvenance, { installKind: "archive" }>;

/** A cached check answers repeated triggers for this long. */
const SERVER_UPDATE_CHECK_TTL_MS = 30 * 60_000;
/** The boot check waits this long, so it never competes with startup. */
const SERVER_UPDATE_BOOT_CHECK_DELAY_MS = 60_000;
/** `after-24h`'s delay, from the first check that saw the version. */
export const SERVER_UPDATE_DOWNLOAD_DELAY_MS = 24 * 60 * 60_000;
const PROGRESS_POLL_MS = 1_000;
/**
 * The longest timer armed for a download deadline. Node clamps a delay past
 * 2^31-1 ms to 1 ms (review F3); a far deadline is reached by re-arming.
 */
export const MAX_TIMER_MS = 6 * 60 * 60_000;
/**
 * Waits before retrying something that failed: a download-deadline check
 * that could not verify the manifest, and a policy download that failed
 * (review round 2). The last one repeats.
 */
const RETRY_BACKOFF_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

function backoff(attempt: number): number {
  return RETRY_BACKOFF_MS[
    Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1
  ] as number;
}
/** Turns end in bursts (a turn and its children); one evaluation per burst. */
const IDLE_DEBOUNCE_MS = 2_000;

/** One running turn as the idle check needs it: only whether any exist. */
export interface RunningTurnSummary {
  sessionId: string;
}

/**
 * The broadcast copy of the state (review F12): a staging installer's last
 * error line, and a launcher refusal's text, stay on the authenticated state
 * route; every listener gets only that the request failed. Launcher outcome
 * reasons are codes already (`prepared-timeout`, `candidate-exited:1`).
 */
const BROADCAST_WITHHELD_REASON = "withheld";

function broadcastServerUpdateState(
  state: ServerUpdateState,
): ServerUpdateState {
  const { progress } = state;
  if (progress.state !== "staging-failed" && progress.state !== "rejected")
    return state;
  return {
    ...state,
    progress: { ...progress, reason: BROADCAST_WITHHELD_REASON },
  };
}

export interface ServerUpdateCoordinatorDeps {
  /** This server's install provenance. */
  provenance: () => InstallProvenance;
  options?: ArchiveUpdateOptions;
  /** The stored policy; undefined when the setting is absent. */
  readDownloadPolicy: () => Promise<unknown>;
  /**
   * Every session with an active turn on this server, whoever owns it and
   * ephemeral ones included (webhooks, delegations): what a restart stops.
   */
  listRunningTurns: () => Promise<readonly RunningTurnSummary[]>;
  /** The server event bus; the coordinator listens for turns ending. */
  subscribe?: (
    listener: (message: {
      event: string;
      data?: Record<string, unknown>;
    }) => void,
  ) => () => void;
  /** Pushes the state to every client. */
  publish: (state: ServerUpdateState) => void;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
  checkTtlMs?: number;
  bootCheckDelayMs?: number;
  progressPollMs?: number;
  idleDebounceMs?: number;
}

interface PersistedIntent {
  availableSince?: { version: string; at: string };
  applyWhenIdle?: { version: string; requestedAt: string };
  /**
   * The policy's last download of a version (review F4): when, how many
   * attempts, the request it wrote, or that the request was refused.
   */
  autoStaged?: {
    version: string;
    at: string;
    attempts: number;
    requestId?: string;
    refused?: true;
  };
}

interface CachedCheck {
  at: number;
  status: ArchiveUpdateStatus;
}

export type ServerUpdateActionResult =
  | { ok: true; state: ServerUpdateState; requestId?: string }
  | { ok: false; status: 409 | 500; error: string };

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function defaultTimer(callback: () => void, ms: number) {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Tags an intent built from a read that failed (round 4 item 1). Object
 * spread and rest copy own symbol keys, so every intent derived from it
 * keeps the tag, and `tryWriteIntent` refuses to write it over the file.
 */
const UNREADABLE = Symbol("intent-unreadable");

function isUnreadable(intent: PersistedIntent): boolean {
  return (intent as Record<symbol, unknown>)[UNREADABLE] === true;
}

/**
 * The persisted intent; null when the file exists but could not be read
 * (EMFILE, EACCES), which says nothing about what it holds (round 3 item
 * 8). A missing or malformed file holds no intent.
 */
function readIntentFile(path: string): PersistedIntent | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, Record<string, unknown> | undefined>;
  const intent: PersistedIntent = {};
  const since = raw.availableSince;
  if (
    since &&
    typeof since.version === "string" &&
    VERSION.test(since.version) &&
    isTimestamp(since.at)
  )
    intent.availableSince = { version: since.version, at: since.at };
  const idle = raw.applyWhenIdle;
  if (
    idle &&
    typeof idle.version === "string" &&
    VERSION.test(idle.version) &&
    isTimestamp(idle.requestedAt)
  )
    intent.applyWhenIdle = {
      version: idle.version,
      requestedAt: idle.requestedAt,
    };
  const auto = raw.autoStaged;
  if (
    auto &&
    typeof auto.version === "string" &&
    VERSION.test(auto.version) &&
    isTimestamp(auto.at)
  )
    intent.autoStaged = {
      version: auto.version,
      at: auto.at,
      attempts:
        Number.isSafeInteger(auto.attempts) && (auto.attempts as number) > 0
          ? (auto.attempts as number)
          : 1,
      ...(typeof auto.requestId === "string"
        ? { requestId: auto.requestId }
        : {}),
      ...(auto.refused === true ? { refused: true as const } : {}),
    };
  return intent;
}

/**
 * `X.Y.Z[-ring.N]` out of a client's reported build (`<version>+<commit>`),
 * in the host's version order; null when it is not a release version.
 */
function clientReleaseVersion(build: string | null): string | null {
  if (!build) return null;
  const version = build.split("+", 1)[0] ?? "";
  return clientVersionInHostOrder(version);
}

function normalizeDownloadPolicy(value: unknown): ServerUpdateDownloadPolicy {
  return SERVER_UPDATE_DOWNLOAD_POLICIES.includes(
    value as ServerUpdateDownloadPolicy,
  )
    ? (value as ServerUpdateDownloadPolicy)
    : DEFAULT_SERVER_UPDATE_DOWNLOAD_POLICY;
}

export class ServerUpdateCoordinator {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<
    ServerUpdateCoordinatorDeps["setTimer"]
  >;
  private cached: CachedCheck | null = null;
  private inFlightCheck: Promise<ArchiveUpdateStatus | null> | null = null;
  private downloadDue: { at: number; cancel: () => void } | null = null;
  private bootCheck: { cancel: () => void } | null = null;
  private progressFollow: { cancel: () => void } | null = null;
  private lastPublishedProgress = "";
  private idleTimer: { cancel: () => void } | null = null;
  /** Serializes the apply-when-idle intent's readers and writers (F2). */
  private intentLock: Promise<unknown> = Promise.resolve();
  private idleEvaluationQueued = false;
  /** Set by `markReady`: apply-when-idle waits for a listening server. */
  private ready = false;
  /** The policy the last evaluation used, to tell its own setting changed. */
  private lastPolicy: ServerUpdateDownloadPolicy | null = null;
  /**
   * What this server is, resolved once (round 2 item 1): an install does not
   * change kind under a running process, and the resolution reads files.
   */
  private archiveResolved:
    { value: (ArchiveProvenance & { installRoot: string }) | null } | undefined;
  /**
   * Whether an apply-when-idle intent exists, kept in memory: this
   * coordinator is the intent file's only writer, so the hot path (every
   * runtime event) needs no file read to learn there is nothing to do.
   */
  private knownIdleIntent: PersistedIntent["applyWhenIdle"] | null | undefined;
  /** The running turns the last idle evaluation waited for (item 8). */
  private idleWait: { version: string; turns: number } | null = null;
  /** Consecutive download deadlines whose check failed (item 2). */
  private deadlineFailures = 0;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: ServerUpdateCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultTimer;
  }

  // --- what this server is ------------------------------------------------

  /** The launcher-run archive this server is, or null when it is not one. */
  private archive(): (ArchiveProvenance & { installRoot: string }) | null {
    if (this.archiveResolved) return this.archiveResolved.value;
    const provenance = this.deps.provenance();
    const value =
      provenance.installKind === "archive" &&
      provenance.installRoot &&
      archiveApplyMethod(provenance, this.deps.options?.env) ===
        "service-update"
        ? (provenance as ArchiveProvenance & { installRoot: string })
        : null;
    this.archiveResolved = { value };
    return value;
  }

  supported(): boolean {
    return this.archive() !== null;
  }

  private intentPath(installRoot: string): string {
    return join(serviceUpdatePaths(installRoot).runtime, "server-update.json");
  }

  private readIntent(installRoot: string): PersistedIntent {
    const intent = readIntentFile(this.intentPath(installRoot));
    // An unreadable file leaves the in-memory flag as it was, and what is
    // built from this read is never written over it.
    if (!intent) return { [UNREADABLE]: true } as PersistedIntent;
    this.knownIdleIntent = intent.applyWhenIdle ?? null;
    return intent;
  }

  private writeIntent(installRoot: string, intent: PersistedIntent): void {
    const path = this.intentPath(installRoot);
    if (!intent.availableSince && !intent.applyWhenIdle && !intent.autoStaged) {
      rmSync(path, { force: true });
      this.knownIdleIntent = null;
      return;
    }
    mkdirSync(serviceUpdatePaths(installRoot).runtime, {
      recursive: true,
      mode: 0o700,
    });
    writeJsonAtomically(path, intent);
    this.knownIdleIntent = intent.applyWhenIdle ?? null;
  }

  private async policy(): Promise<ServerUpdateDownloadPolicy> {
    try {
      return normalizeDownloadPolicy(await this.deps.readDownloadPolicy());
    } catch {
      return DEFAULT_SERVER_UPDATE_DOWNLOAD_POLICY;
    }
  }

  // --- the state every client sees ----------------------------------------

  async state(): Promise<ServerUpdateState> {
    const policy = await this.policy();
    const archive = this.archive();
    if (!archive)
      return {
        supported: false,
        currentVersion: null,
        availability: null,
        progress: { state: "unavailable" },
        downloadPolicy: policy,
        autoDownloadAt: null,
        autoDownloadPausedReason: null,
        applyWhenIdle: null,
      };
    const intent = this.readIntent(archive.installRoot);
    // An unreadable file is not an absent intent (round 5 item 1): what this
    // coordinator, the file's only writer, last read or wrote answers.
    const idle = isUnreadable(intent)
      ? (this.knownIdleIntent ?? null)
      : (intent.applyWhenIdle ?? null);
    const progress = readServiceUpdateProgress(archive.installRoot);
    const status = this.cached?.status ?? null;
    const latest = status?.latestVersion ?? null;
    const availableSince =
      status?.updateAvailable && intent.availableSince?.version === latest
        ? intent.availableSince.at
        : null;
    return {
      supported: true,
      currentVersion: archive.version,
      availability: status
        ? {
            checkedAt: new Date(this.cached?.at ?? this.now()).toISOString(),
            releaseCheck: status.releaseCheck,
            latestVersion: latest,
            updateAvailable: status.updateAvailable,
            availableSince,
          }
        : null,
      progress,
      downloadPolicy: policy,
      autoDownloadAt: this.autoDownloadAt(
        policy,
        status,
        availableSince,
        progress,
        intent,
      ),
      autoDownloadPausedReason:
        policy === "never"
          ? null
          : this.autoDownloadPause(status, progress, intent),
      applyWhenIdle: idle
        ? {
            ...idle,
            ...(this.idleWait?.version === idle.version
              ? { waitingForTurns: this.idleWait.turns }
              : {}),
          }
        : null,
    };
  }

  /**
   * Why the policy is not downloading the available release (round 2 item
   * 5): its update failed or rolled back (until a person's Download or a
   * newer release), or its download failed and waits to be retried.
   */
  private autoDownloadPause(
    status: ArchiveUpdateStatus | null,
    progress: ServiceUpdateProgress,
    intent: PersistedIntent,
  ): "update-failed" | "download-failed" | null {
    const latest = status?.latestVersion;
    if (!latest || !status?.updateAvailable) return null;
    if (
      (progress.state === "rolled-back" ||
        progress.state === "failed" ||
        progress.state === "needs-operator") &&
      progress.targetVersion === latest
    )
      return "update-failed";
    return intent.autoStaged?.version === latest &&
      this.autoStageFailed(intent.autoStaged, progress)
      ? "download-failed"
      : null;
  }

  /** The policy's download of a version failed: refused, or staging failed. */
  private autoStageFailed(
    auto: NonNullable<PersistedIntent["autoStaged"]>,
    progress: ServiceUpdateProgress,
  ): boolean {
    if (auto.refused) return true;
    return (
      (progress.state === "staging-failed" || progress.state === "rejected") &&
      progress.requestId === auto.requestId
    );
  }

  /** When the policy downloads the available version; null when it will not. */
  private autoDownloadAt(
    policy: ServerUpdateDownloadPolicy,
    status: ArchiveUpdateStatus | null,
    availableSince: string | null,
    progress: ServiceUpdateProgress,
    intent: PersistedIntent,
  ): string | null {
    if (
      policy === "never" ||
      !availableSince ||
      !this.downloadable(status, progress)
    )
      return null;
    const latest = status?.latestVersion;
    // A version whose update rolled back or failed waits for a person or a
    // newer release. And never under a pending apply-when-idle (F6): it
    // waits for the staged version, which a newer stage would replace.
    if (intent.applyWhenIdle) return null;
    const auto = intent.autoStaged;
    if (auto?.version === latest) {
      // A download the policy started: once its staging failed (or it was
      // refused), it is retried after a backoff (round 2 item 5); while it
      // runs or after it succeeded, nothing.
      if (!this.autoStageFailed(auto, progress)) return null;
      return new Date(
        Date.parse(auto.at) + backoff(auto.attempts),
      ).toISOString();
    }
    if (
      (progress.state === "rolled-back" ||
        progress.state === "failed" ||
        progress.state === "needs-operator") &&
      progress.targetVersion === latest
    )
      return null;
    if (policy === "immediately") return availableSince;
    return new Date(
      Date.parse(availableSince) + SERVER_UPDATE_DOWNLOAD_DELAY_MS,
    ).toISOString();
  }

  /** A verified newer release this server could stage now. */
  private downloadable(
    status: ArchiveUpdateStatus | null,
    progress: ServiceUpdateProgress,
  ): status is ArchiveUpdateStatus & { latestVersion: string } {
    if (
      status?.releaseCheck !== "verified" ||
      !status.updateAvailable ||
      !status.latestVersion ||
      status.selfUpdateUnavailableReason
    )
      return false;
    if (
      progress.state === "queued" ||
      progress.state === "staging" ||
      progress.state === "updating" ||
      progress.state === "needs-operator"
    )
      return false;
    return !(
      progress.state === "staged" && progress.version === status.latestVersion
    );
  }

  async publish(): Promise<void> {
    if (this.stopped) return;
    try {
      const state = await this.state();
      this.lastPublishedProgress = JSON.stringify(state.progress);
      this.deps.publish(broadcastServerUpdateState(state));
    } catch (error) {
      this.deps.logger.warn("Server update: could not publish its state", {
        error: (error as Error).message,
      });
    }
  }

  // --- lifecycle ----------------------------------------------------------

  /** Arms the boot check and the turn listener; returns the disposer. */
  start(): () => void {
    const archive = this.archive();
    if (!archive) return () => undefined;
    this.dropStaleIntent(archive);
    this.bootCheck = this.setTimer(() => {
      this.bootCheck = null;
      void this.check("boot");
    }, this.deps.bootCheckDelayMs ?? SERVER_UPDATE_BOOT_CHECK_DELAY_MS);
    this.unsubscribe =
      this.deps.subscribe?.((message) => this.onBusEvent(message)) ?? null;
    this.followProgress();
    // The baseline a settings save is compared with: the policy as it stood
    // at start, so only a change of it counts.
    void this.policy().then((policy) => {
      this.lastPolicy ??= policy;
    });
    return () => this.stop();
  }

  /**
   * The server listens and its turn recovery has run (F8): only now can the
   * active-turn reads say a persisted apply-when-idle may restart it.
   */
  markReady(): void {
    if (this.ready || this.stopped) return;
    this.ready = true;
    const archive = this.archive();
    if (archive && this.readIntent(archive.installRoot).applyWhenIdle)
      void this.evaluateIdle();
  }

  stop(): void {
    this.stopped = true;
    this.bootCheck?.cancel();
    this.downloadDue?.cancel();
    this.progressFollow?.cancel();
    this.idleTimer?.cancel();
    this.unsubscribe?.();
    this.bootCheck = null;
    this.downloadDue = null;
    this.progressFollow = null;
    this.idleTimer = null;
    this.unsubscribe = null;
  }

  /**
   * After an update commits, the new server finds the old one's records: an
   * intent to apply the version it now runs (or an older one), or an
   * availability record for a version that is no longer newer.
   */
  private dropStaleIntent(
    archive: ArchiveProvenance & { installRoot: string },
  ) {
    const intent = this.readIntent(archive.installRoot);
    // It builds a fresh record, which would drop the unreadable tag.
    if (isUnreadable(intent)) return;
    const stale = (version: string | undefined) =>
      version !== undefined &&
      compareStationReleaseVersions(version, archive.version) !== 1;
    if (
      !stale(intent.applyWhenIdle?.version) &&
      !stale(intent.availableSince?.version) &&
      !stale(intent.autoStaged?.version)
    )
      return;
    // Each record goes only if it names a version no longer newer; the
    // policy's download record stays otherwise (round 2 item 9).
    const next: PersistedIntent = {
      ...(stale(intent.availableSince?.version)
        ? {}
        : { availableSince: intent.availableSince }),
      ...(stale(intent.applyWhenIdle?.version)
        ? {}
        : { applyWhenIdle: intent.applyWhenIdle }),
      ...(stale(intent.autoStaged?.version)
        ? {}
        : { autoStaged: intent.autoStaged }),
    };
    this.tryWriteIntent(archive.installRoot, next);
  }

  private tryWriteIntent(
    installRoot: string,
    intent: PersistedIntent,
  ): boolean {
    // Built from a read that failed: writing it would erase what the file
    // holds (a pending update when idle, the policy's records).
    if (isUnreadable(intent)) {
      this.deps.logger.warn(
        "Server update: its intent file could not be read; not writing over it",
      );
      return false;
    }
    try {
      this.writeIntent(installRoot, intent);
      return true;
    } catch (error) {
      this.deps.logger.warn("Server update: could not record its intent", {
        error: (error as Error).message,
      });
      return false;
    }
  }

  // --- checking -----------------------------------------------------------

  /**
   * A client reported its build on connecting. A release newer than this
   * server means a newer Station exists: check (the TTL absorbs repeats).
   */
  noteClientBuild(build: string | null): void {
    const archive = this.archive();
    if (!archive) return;
    const client = clientReleaseVersion(build);
    if (!client) return;
    if (compareStationReleaseVersions(client, archive.version) !== 1) return;
    void this.check("newer-client");
  }

  /**
   * Checks for a newer release, unless a check younger than the TTL already
   * answered (`force` skips that). Concurrent triggers share one fetch.
   */
  async check(
    trigger: string,
    options: { force?: boolean } = {},
  ): Promise<ArchiveUpdateStatus | null> {
    const archive = this.archive();
    if (!archive || this.stopped) return null;
    const ttl = this.deps.checkTtlMs ?? SERVER_UPDATE_CHECK_TTL_MS;
    if (!options.force && this.cached && this.now() - this.cached.at < ttl)
      return this.cached.status;
    if (this.inFlightCheck) return this.inFlightCheck;
    this.inFlightCheck = (async () => {
      try {
        const status = await archiveUpdateStatus(archive, this.deps.options);
        this.deps.logger.info("Server update check", {
          trigger,
          releaseCheck: status.releaseCheck,
          latestVersion: status.latestVersion ?? null,
          updateAvailable: status.updateAvailable,
        });
        await this.recordCheck(status, { applyPolicy: true });
        return status;
      } catch (error) {
        this.deps.logger.warn("Server update check failed", {
          trigger,
          error: (error as Error).message,
        });
        return null;
      } finally {
        this.inFlightCheck = null;
      }
    })();
    return this.inFlightCheck;
  }

  /**
   * Records a check's result. Only the coordinator's own checks
   * (`applyPolicy`) let the download policy act on it; a client's fresh
   * `GET /core-update` only refreshes what the state reports (F4).
   */
  async recordCheck(
    status: ArchiveUpdateStatus,
    options: { applyPolicy?: boolean } = {},
  ): Promise<void> {
    const archive = this.archive();
    if (!archive || this.stopped) return;
    this.cached = { at: this.now(), status };
    let intent = this.readIntent(archive.installRoot);
    // A first sighting recorded in the future (a clock that ran ahead) would
    // put the download beyond any sane timer: it counts from now (F3).
    if (
      intent.availableSince &&
      Date.parse(intent.availableSince.at) > this.now()
    ) {
      intent = {
        ...intent,
        availableSince: {
          ...intent.availableSince,
          at: new Date(this.now()).toISOString(),
        },
      };
      this.tryWriteIntent(archive.installRoot, intent);
    }
    // Only a verified answer changes the record: an unreachable manifest says
    // nothing about whether the version stopped being available.
    if (status.releaseCheck === "verified") {
      // Any verified check ends a run of failed deadline checks (item 7).
      this.deadlineFailures = 0;
      const latest = status.updateAvailable ? status.latestVersion : undefined;
      if (latest && intent.availableSince?.version !== latest)
        this.tryWriteIntent(archive.installRoot, {
          ...intent,
          availableSince: {
            version: latest,
            at: new Date(this.now()).toISOString(),
          },
        });
      else if (!latest && intent.availableSince) {
        const { availableSince: _gone, ...rest } = intent;
        this.tryWriteIntent(archive.installRoot, rest);
      }
    }
    if (options.applyPolicy) await this.applyDownloadPolicy();
    await this.publish();
  }

  /** Stages the available version when the policy's delay has passed. */
  private async applyDownloadPolicy(): Promise<void> {
    this.downloadDue?.cancel();
    this.downloadDue = null;
    const archive = this.archive();
    if (!archive) return;
    // The intent holds what blocks or delays a download (a pending update
    // when idle, the backoff of a failed one): unread, nothing is started.
    if (isUnreadable(this.readIntent(archive.installRoot))) {
      this.deps.logger.warn(
        "Server update: its intent file could not be read; the download policy waits",
      );
      return;
    }
    const state = await this.state();
    this.lastPolicy = state.downloadPolicy;
    if (!state.autoDownloadAt || state.downloadPolicy === "never") return;
    const due = Date.parse(state.autoDownloadAt);
    const wait = due - this.now();
    if (wait > 0) {
      this.armDownloadDeadline(due);
      return;
    }
    const version = state.availability?.latestVersion ?? null;
    // Recorded before the request, so even a download that fails at once is
    // not started again by the next trigger until its backoff passed (F4).
    const previous = this.readIntent(archive.installRoot);
    const attempts =
      previous.autoStaged?.version === version
        ? previous.autoStaged.attempts + 1
        : 1;
    const at = new Date(this.now()).toISOString();
    if (version)
      this.tryWriteIntent(archive.installRoot, {
        ...previous,
        autoStaged: { version, at, attempts },
      });
    const result = await this.request("stage");
    if (version)
      this.tryWriteIntent(archive.installRoot, {
        ...this.readIntent(archive.installRoot),
        autoStaged: {
          version,
          at,
          attempts,
          ...(result.ok
            ? { requestId: result.requestId }
            : { refused: true as const }),
        },
      });
    if (result.ok)
      this.deps.logger.info("Server update: downloading by policy", {
        policy: state.downloadPolicy,
        version,
      });
    else
      this.deps.logger.warn("Server update: the policy download was refused", {
        error: result.error,
      });
  }

  /**
   * Waits for a download deadline (round 2 item 2). A timer that fires
   * before the deadline (timers are capped at MAX_TIMER_MS) re-arms without
   * fetching anything; at the deadline one check runs, and the policy acts on
   * it. A check that fails or does not verify is retried after a backoff.
   */
  private armDownloadDeadline(due: number): void {
    // Nothing is armed once stopped (round 3 item 2).
    if (this.stopped) return;
    this.downloadDue?.cancel();
    const timer = this.setTimer(
      () => {
        this.downloadDue = null;
        if (this.now() < due) this.armDownloadDeadline(due);
        else void this.downloadDeadlineReached();
      },
      Math.min(Math.max(due - this.now(), 0), MAX_TIMER_MS),
    );
    this.downloadDue = { at: due, ...timer };
  }

  private async downloadDeadlineReached(): Promise<void> {
    if (this.stopped) return;
    const status = await this.check("download-due", { force: true });
    // A verified check reset the failure count and let the policy act.
    if (status?.releaseCheck === "verified" || this.stopped) return;
    // While the check ran (and the policy read), the policy may have been
    // set to `never`, or re-run and armed a deadline of its own (a client's
    // check racing a settings save, a recordCheck that threw after the
    // policy armed one): the failure is then nobody's to retry (rounds 3-5).
    // `stopped` is checked here too, though arming refuses after stop, so a
    // stopped coordinator does not log a retry it will not arm.
    if ((await this.policy()) === "never" || this.stopped) return;
    if (this.downloadDue) return;
    this.deadlineFailures += 1;
    const retryAt = this.now() + backoff(this.deadlineFailures);
    this.deps.logger.warn("Server update: the download deadline check failed", {
      retryAt: new Date(retryAt).toISOString(),
    });
    this.armDownloadDeadline(retryAt);
  }

  /**
   * Some setting changed. Only a change of the download policy itself
   * re-evaluates it (F4): saving any other setting downloads nothing.
   */
  async settingsChanged(): Promise<void> {
    if (!this.archive() || this.stopped) return;
    const policy = await this.policy();
    if (this.lastPolicy === null) {
      // No baseline yet: this read becomes it, and is not a change.
      this.lastPolicy = policy;
      return;
    }
    if (policy === this.lastPolicy) return;
    if (this.cached) await this.applyDownloadPolicy();
    else this.lastPolicy = policy;
    await this.publish();
  }

  // --- requests -----------------------------------------------------------

  private async request(
    intent: "stage" | "apply" | "update",
    version?: string,
  ): Promise<ArchiveApplyResult> {
    const archive = this.archive();
    if (!archive)
      return {
        ok: false,
        status: 409,
        error:
          "This Station server is not run by the Station service’s launcher, so it cannot update itself.",
      };
    const result =
      intent === "apply"
        ? await applyStagedServerUpdate(archive, this.deps.options, version)
        : await applyArchiveUpdate(archive, this.deps.options, { intent });
    if (result.ok) this.followProgress();
    return result;
  }

  /** Download and verify the newest release; nothing restarts. */
  async stage(): Promise<ServerUpdateActionResult> {
    // A new download would replace (and prune) the staged version an
    // apply-when-idle waits for (round 2 item 7).
    const archive = this.archive();
    const current = archive ? this.readIntent(archive.installRoot) : {};
    if (isUnreadable(current))
      return {
        ok: false,
        status: 500,
        error:
          "Station could not read its update records, which may hold an update when idle; nothing was downloaded.",
      };
    if (current.applyWhenIdle)
      return {
        ok: false,
        status: 409,
        error:
          "An update when idle is waiting for the downloaded version; cancel it before downloading another.",
      };
    const result = await this.request("stage");
    if (!result.ok) return result;
    await this.publish();
    return { ok: true, state: await this.state(), requestId: result.requestId };
  }

  /** Restart into the staged `version`, interrupting whatever runs. */
  async apply(version?: string): Promise<ServerUpdateActionResult> {
    const result = await this.request("apply", version);
    if (!result.ok) return result;
    const archive = this.archive();
    if (archive) {
      const intent = this.readIntent(archive.installRoot);
      if (intent.applyWhenIdle) {
        const { applyWhenIdle: _applied, ...rest } = intent;
        this.tryWriteIntent(archive.installRoot, rest);
      }
    }
    await this.publish();
    return { ok: true, state: await this.state(), requestId: result.requestId };
  }

  /** Runs `operation` after every earlier intent operation finished. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.intentLock.then(operation, operation);
    this.intentLock = run.catch(() => undefined);
    return run;
  }

  /** Apply the staged `version` once no agent turn is running. */
  async setApplyWhenIdle(version: string): Promise<ServerUpdateActionResult> {
    const result = await this.exclusive(() => this.writeApplyWhenIdle(version));
    if (result.ok) void this.evaluateIdle();
    return result;
  }

  private async writeApplyWhenIdle(
    version: string,
  ): Promise<ServerUpdateActionResult> {
    const archive = this.archive();
    if (!archive)
      return {
        ok: false,
        status: 409,
        error:
          "This Station server is not run by the Station service’s launcher, so it cannot update itself.",
      };
    const progress = readServiceUpdateProgress(archive.installRoot);
    if (progress.state !== "staged" || progress.version !== version)
      return {
        ok: false,
        status: 409,
        error:
          progress.state === "staged"
            ? `The downloaded update is ${progress.version}, not ${version}; check for updates again.`
            : "No downloaded update is ready to apply; download the update first.",
      };
    const intent = this.readIntent(archive.installRoot);
    if (
      !this.tryWriteIntent(archive.installRoot, {
        ...intent,
        applyWhenIdle: {
          version,
          requestedAt: new Date(this.now()).toISOString(),
        },
      })
    )
      return {
        ok: false,
        status: 500,
        error: "Station could not record the request to update when idle.",
      };
    await this.publish();
    return { ok: true, state: await this.state() };
  }

  /**
   * Cancels the intent (review F2). It does not queue behind an evaluation
   * waiting on the running turns: that would let the evaluation apply first.
   * Its read and write are synchronous (nothing is awaited before the intent
   * is gone), and the evaluation re-reads the intent after its only wait and
   * writes the apply request in the same synchronous stretch, so either the
   * cancel lands first and nothing restarts, or the restart was already
   * requested, which the cancel then reports instead of claiming.
   */
  cancelApplyWhenIdle(): Promise<ServerUpdateActionResult> {
    return this.removeApplyWhenIdle();
  }

  private async removeApplyWhenIdle(): Promise<ServerUpdateActionResult> {
    const archive = this.archive();
    if (archive) {
      const intent = this.readIntent(archive.installRoot);
      // Unread is not absent: claiming a cancel would leave the intent.
      if (isUnreadable(intent))
        return {
          ok: false,
          status: 500,
          error: "Station could not read its request to update when idle.",
        };
      const progress = readServiceUpdateProgress(archive.installRoot);
      if (
        progress.state === "updating" ||
        ((progress.state === "queued" || progress.state === "staging") &&
          progress.intent === "apply")
      ) {
        // The restart is already requested; the intent it fulfilled goes.
        if (intent.applyWhenIdle) {
          const { applyWhenIdle: _fulfilled, ...rest } = intent;
          this.tryWriteIntent(archive.installRoot, rest);
        }
        return {
          ok: false,
          status: 409,
          error: "The server is already restarting into the update.",
        };
      }
      if (intent.applyWhenIdle) {
        const { applyWhenIdle: _cancelled, ...rest } = intent;
        if (!this.tryWriteIntent(archive.installRoot, rest))
          return {
            ok: false,
            status: 500,
            error: "Station could not cancel the request to update when idle.",
          };
      }
    }
    await this.publish();
    return { ok: true, state: await this.state() };
  }

  // --- apply when idle ----------------------------------------------------

  private onBusEvent(message: {
    event: string;
    data?: Record<string, unknown>;
  }): void {
    // The policy is a setting: a saved change of IT re-evaluates at once
    // (settingsChanged ignores every other setting's change). Handled on the
    // subscription start() makes, so only a launcher-run server listens.
    if (message.event === SERVER_EVENTS.CONFIG_CHANGED) {
      void this.settingsChanged();
      return;
    }
    // Any runtime event may be the end of the last turn (a completion, an
    // abort, an exit, a runtime error, a stop settling): rather than name
    // them all, every one re-evaluates, at most once per interval (F5). The
    // timer is not reset by later events, so a busy stream cannot starve it.
    // The flag first (round 2 item 1): with no intent pending, a runtime
    // event costs nothing else, no file read and no provenance resolution.
    if (!this.knownIdleIntent) return;
    if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT || this.idleTimer)
      return;
    if (!this.ready) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      void this.evaluateIdle();
    }, this.deps.idleDebounceMs ?? IDLE_DEBOUNCE_MS);
  }

  /**
   * Applies the intended version when no turn runs. An intent whose version
   * is no longer the staged one is dropped: it promised that version only.
   */
  async evaluateIdle(): Promise<void> {
    if (this.idleEvaluationQueued || this.stopped || !this.ready) return;
    this.idleEvaluationQueued = true;
    await this.exclusive(async () => {
      this.idleEvaluationQueued = false;
      await this.evaluateIdleNow();
    });
  }

  private async evaluateIdleNow(): Promise<void> {
    const archive = this.archive();
    if (!archive || this.stopped) return;
    {
      const intent = this.readIntent(archive.installRoot).applyWhenIdle;
      if (!intent) return;
      const progress = readServiceUpdateProgress(archive.installRoot);
      if (progress.state !== "staged" || progress.version !== intent.version) {
        // In flight (an apply already queued): leave it. Anything else: the
        // staged version the intent named is gone.
        if (
          progress.state !== "queued" &&
          progress.state !== "staging" &&
          progress.state !== "updating"
        ) {
          const { applyWhenIdle: _dropped, ...rest } = this.readIntent(
            archive.installRoot,
          );
          this.tryWriteIntent(archive.installRoot, rest);
          await this.publish();
        }
        return;
      }
      let running: readonly RunningTurnSummary[];
      try {
        running = await this.deps.listRunningTurns();
      } catch (error) {
        // Not knowing is not idle.
        this.deps.logger.warn("Server update: could not list running turns", {
          error: (error as Error).message,
        });
        return;
      }
      if (running.length > 0) {
        // What the wait is for, so a turn that never ends is visible.
        this.idleWait = { version: intent.version, turns: running.length };
        await this.publish();
        return;
      }
      this.idleWait = null;
      // The intent is read again after the wait: only the version it still
      // names, if it still names one, is applied.
      const current = this.readIntent(archive.installRoot).applyWhenIdle;
      if (current?.version !== intent.version) return;
      this.deps.logger.info("Server update: applying when idle", {
        version: intent.version,
      });
      const result = await this.apply(intent.version);
      if (!result.ok)
        this.deps.logger.warn("Server update: the idle apply was refused", {
          error: result.error,
        });
    }
  }

  // --- progress -----------------------------------------------------------

  /**
   * Pushes each change of a queued or staging request's progress, reading
   * the runtime files once a second only while one is in those states.
   */
  private followProgress(): void {
    if (this.progressFollow || this.stopped) return;
    const archive = this.archive();
    if (!archive) return;
    const tick = () => {
      this.progressFollow = null;
      if (this.stopped) return;
      const progress = readServiceUpdateProgress(archive.installRoot);
      const serialized = JSON.stringify(progress);
      const changed = serialized !== this.lastPublishedProgress;
      const following =
        progress.state === "queued" || progress.state === "staging";
      if (following)
        this.progressFollow = this.setTimer(
          tick,
          this.deps.progressPollMs ?? PROGRESS_POLL_MS,
        );
      if (!changed) return;
      void this.publish().then(() => {
        // A stage that just finished may be what an idle intent waits for.
        if (progress.state === "staged") void this.evaluateIdle();
      });
    };
    tick();
  }
}
