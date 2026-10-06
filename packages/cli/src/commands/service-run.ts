import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as setNodeTimeout } from 'node:timers';
import type { ClaimHostOwnerResult } from '@kontourai/station-shared/instance-registry';
import { createDesktopCompanion } from './desktop-companion.js';
import {
  type CollectedChildStatus,
  type CollectedInstanceStatus,
  checkSourceBuildStamp,
  collectInstanceStatus,
  describeSourceBuildStampProblem,
  findListeningPidsForPorts,
  type InstanceStateRecord,
  isBuildStale,
  resolveBuildPaths,
  sourceBuildStampNeedsRebuild,
  start,
  stop,
} from './lifecycle.js';
import type { ServiceLifecycleArgs } from './service.js';
import { SERVICE_SHUTDOWN_DEADLINE_MS } from './service-command.js';
import {
  processServiceLauncherLink,
  type ServiceLauncherLink,
} from './service-launcher-link.js';
import {
  claimServiceHost,
  describeServiceHostRefusal,
  handOffServiceLivenessToLauncher,
  publishServiceLivenessRecord,
  serviceHostIsOwned,
} from './service-liveness.js';

export interface SupervisorDependencies {
  desktopCompanion?: { check: () => void };
  collect?: typeof collectInstanceStatus;
  exit?: (code: number) => void;
  /**
   * station#1869: decides whether the supervisor should BUILD before
   * starting, rather than warn-and-reuse a stale build (which crashes a
   * supervised process and loops under KeepAlive). Defaults to the real
   * `isBuildStale(resolveBuildPaths(instanceName))`; injected as a test seam.
   */
  needsBuildForInstance?: (instanceName: string) => boolean;
  now?: () => number;
  listListeningPids?: (port: number) => number[];
  /**
   * Publishes/clears this supervisor's liveness on its own service registry
   * entry (station#3064). Injected as a test seam; defaults to the real
   * ownership-checked updater.
   */
  publishServiceLiveness?: (live: boolean) => void;
  /**
   * Claims this home's single host before Station starts (#2961). Test seam;
   * defaults to the real host-owner claim on this service's registry entry.
   */
  claimServiceHost?: () => ClaimHostOwnerResult;
  /** Successful reads verify the ready supervisor; unreadable reads throw. */
  serviceHostIsOwned?: () => boolean;
  /**
   * Re-points this supervisor's liveness entry at the fixed launcher when an
   * update takes over the service (#2675 D, correction 8). Test seam.
   */
  handOffServiceLiveness?: (launcherPid: number) => void;
  /**
   * The fixed launcher's channel (#2675 D). Undefined: this process's own,
   * when a launcher started it; null: none. Test seam.
   */
  launcherLink?: ServiceLauncherLink | null;
  processIsAlive?: (pid: number) => boolean;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
  // NodeJS.Timeout rather than ReturnType<typeof setTimeout>: this module is
  // reachable from the e2e program, whose tsconfig includes the DOM lib, where
  // setTimeout resolves to the overload returning number. The supervisor's
  // timers are always Node timers, so name that type instead of inheriting
  // whichever lib happens to be in scope.
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  start?: typeof start;
  stop?: typeof stop;
}

const CHECK_INTERVAL_MS = 5_000;

/**
 * Steady-state identity probes answer in single-digit milliseconds on an idle
 * host, but the same busy-host hazard startup already absorbs with its
 * readiness budget (lifecycle.ts STARTUP_READINESS_TIMEOUT_MS, a base that
 * extends to STARTUP_READINESS_MAX_TIMEOUT_MS since #2646) applies after
 * boot too: a loaded development machine can stall an HTTP round-trip well
 * past 3s while the server stays healthy. The old 3s budget plus a bare
 * three-strike rule destroyed a working Station 31 times in one measured day
 * (station#1846). The probe budget is a slowness detector, not a death
 * detector — death is decided by process liveness, socket state, and identity
 * below.
 */
const STEADY_PROBE_TIMEOUT_MS = 10_000;

/** Consecutive probes answering with a DIFFERENT identity before teardown. */
const IDENTITY_MISMATCH_TEARDOWN_STRIKES = 3;

/** Consecutive definitively-refused socket connections before teardown. */
const LISTENER_GONE_TEARDOWN_STRIKES = 3;

/**
 * How long a child may fail HTTP probes continuously — while its process is
 * alive and its port is still listening — before the supervisor escalates to
 * a long-budget confirmation probe.
 *
 * This was "double the startup allowance". Since #2646 it EQUALS it: the
 * startup budget is an extendable base reaching
 * STARTUP_READINESS_MAX_TIMEOUT_MS (90s + 2x45s = 180s) whenever a `childAlive`
 * probe is supplied, which `start()` always does. The invariant the original
 * comment encoded — a booted Station under load gets at least the grace a
 * booting one does — is now met exactly rather than with margin.
 */
const UNRESPONSIVE_ESCALATION_MS = 180_000;

/**
 * The confirmation probe's budget. A starved-but-working child answers within
 * this; a genuinely wedged event loop never answers at all, so this bounds
 * how long a truly broken child can linger past the escalation window.
 */
const CONFIRMATION_PROBE_TIMEOUT_MS = 45_000;

/**
 * An HTTP 401/403 from a child's own identity endpoint is a definitive
 * credential fault, not busy-host slowness. Require both a sustained window
 * and multiple samples to avoid restarting for a transient auth handoff.
 */
const AUTH_REFUSAL_TEARDOWN_STRIKES = 6;
const AUTH_REFUSAL_ESCALATION_MS = 60_000;
/**
 * Cross-restart damping (sol review of #2669, finding 1): the process
 * managers restart this supervisor unconditionally (systemd Restart=always,
 * launchd KeepAlive), so an auth wedge that survives a restart would loop
 * teardown -> restart -> 60s of 401s -> teardown forever. After this many
 * auth escalations inside the window, the supervisor STOPS escalating and
 * falls back to tolerating with a distinct log — the service stays up for
 * direct callers while the doctor names the wedge.
 */
const AUTH_ESCALATION_LOOP_CAP = 3;
const AUTH_ESCALATION_LOOP_WINDOW_MS = 15 * 60_000;

const RECOVERY_CYCLE_CAP = 3;
const RECOVERY_CYCLE_WINDOW_MS = 30 * 60_000;

interface ChildProbeState {
  authRefusalSinceMs?: number;
  authRefusalStrikes: number;
  failingSinceMs?: number;
  identityMismatchStrikes: number;
  listenerGoneStrikes: number;
  recoveryTimestamps: number[];
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sameBoot(
  actual: CollectedInstanceStatus,
  expected: CollectedInstanceStatus,
): boolean {
  return actual.bootId === expected.bootId && actual.sha === expected.sha;
}

export async function superviseService(
  lifecycle: ServiceLifecycleArgs,
  dependencies: SupervisorDependencies = {},
): Promise<void> {
  const instanceName = lifecycle.instanceName ?? 'default';
  const desktopCompanion =
    dependencies.desktopCompanion ??
    createDesktopCompanion(lifecycle.baseDir, {
      stationRoot: lifecycle.stationRoot,
    });
  const startInstance = dependencies.start ?? start;
  const stopInstance = dependencies.stop ?? stop;
  const collect = dependencies.collect ?? collectInstanceStatus;
  const needsBuildForInstance =
    dependencies.needsBuildForInstance ??
    ((name: string) => {
      if (isBuildStale(resolveBuildPaths(name))) return true;
      // station#2689: a bundle whose build stamp is missing or names another
      // sha boots into "managed boot identity mismatch" on every restart, the
      // same KeepAlive loop as a stale bundle, so it is rebuilt the same way.
      const stamp = checkSourceBuildStamp(name);
      if (sourceBuildStampNeedsRebuild(stamp)) return true;
      // Missing, but HEAD is unreadable: buildApplication stamps from that
      // same HEAD, so a rebuild would run for minutes and then throw — on
      // every KeepAlive restart. Say so once per boot and start as-is; the
      // boot then fails fast on its identity check, naming the sha.
      const problem = describeSourceBuildStampProblem(stamp);
      if (problem) {
        console.error(
          `Station service ${name}: not rebuilding — ${problem}. Make git able to read HEAD for this checkout, then run \`station build${name === 'default' ? '' : ` --instance=${name}`}\`.`,
        );
      }
      return false;
    });
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const livenessTarget = {
    instanceName,
    home: lifecycle.baseDir,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
  };
  const publishServiceLiveness =
    dependencies.publishServiceLiveness ??
    ((live: boolean) => publishServiceLivenessRecord(livenessTarget, live));
  let recoveringOwnership = false;
  const claimHost =
    dependencies.claimServiceHost ??
    (() => claimServiceHost(livenessTarget, 'starting', recoveringOwnership));
  const ownsHost =
    dependencies.serviceHostIsOwned ??
    (() => serviceHostIsOwned(livenessTarget));
  const handOffServiceLiveness =
    dependencies.handOffServiceLiveness ??
    ((launcherPid: number) =>
      handOffServiceLivenessToLauncher(livenessTarget, launcherPid));
  const processIsAlive = dependencies.processIsAlive ?? defaultProcessIsAlive;
  const now = dependencies.now ?? Date.now;
  const listListeningPids =
    dependencies.listListeningPids ??
    ((port: number) => findListeningPidsForPorts([port]));
  const onSignal =
    dependencies.onSignal ??
    ((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      process.on(signal, listener);
    });
  // Annotated, not inferred: this module is reachable from the e2e program,
  // whose tsconfig includes the DOM lib, where the ambient setTimeout overload
  // returns number. The supervisor's timers are always Node timers.
  const setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout =
    dependencies.setTimer ?? setNodeTimeout;
  let shuttingDown = false;
  let timer: NodeJS.Timeout | undefined;
  let consecutiveSupervisorFailures = 0;
  let startPromise: Promise<void> | undefined;
  let generation: InstanceStateRecord | null = null;
  const stopOwnedGeneration = () =>
    stopInstance({ instanceName, stateHome: lifecycle.baseDir, generation });
  let shutdownPromise: Promise<void> | undefined;
  let wakeOwnershipWait: (() => void) | undefined;
  const childState: Record<'server' | 'ui', ChildProbeState> = {
    server: {
      authRefusalStrikes: 0,
      identityMismatchStrikes: 0,
      listenerGoneStrikes: 0,
      recoveryTimestamps: [],
    },
    ui: {
      authRefusalStrikes: 0,
      identityMismatchStrikes: 0,
      listenerGoneStrikes: 0,
      recoveryTimestamps: [],
    },
  };
  const resetChildProbeState = (name: 'server' | 'ui'): void => {
    const state = childState[name];
    state.failingSinceMs = undefined;
    state.authRefusalSinceMs = undefined;
    state.authRefusalStrikes = 0;
    state.identityMismatchStrikes = 0;
    state.listenerGoneStrikes = 0;
  };

  const shutdown = (code: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (timer) clearTimeout(timer);
    wakeOwnershipWait?.();
    const forceExitTimer = setTimer(() => {
      console.error(
        `Station service shutdown exceeded ${SERVICE_SHUTDOWN_DEADLINE_MS / 1000}s; forcing exit`,
      );
      exit(1);
    }, SERVICE_SHUTDOWN_DEADLINE_MS);
    // Timers from the production seam are NodeJS.Timeouts; deterministic test
    // seams may return a number, which intentionally has no unref method.
    if (
      typeof forceExitTimer === 'object' &&
      forceExitTimer !== null &&
      'unref' in forceExitTimer
    ) {
      forceExitTimer.unref();
    }
    shutdownPromise = (async () => {
      // start() can detach children before it publishes their instance record.
      // Wait for that transaction to settle, then stop its captured generation
      // so a signal cannot strand children in the publication window.
      await startPromise?.catch(() => undefined);
      try {
        if (startPromise) {
          await stopOwnedGeneration();
        }
      } catch (error) {
        console.error('Station service cleanup failed:', error);
      }
      // Retract the liveness claim (station#3064) even when the stop above
      // failed: this process is exiting either way, and a stale live-looking
      // service entry is what keeps Desktop from taking the home back. A
      // crash bypasses this, which is why the signal is pid+birth rather
      // than a status flag — a dead pid reads as not-live to every consumer.
      publishServiceLiveness(false);
      clearTimeout(forceExitTimer);
      exit(code);
    })();
    return shutdownPromise;
  };

  onSignal('SIGINT', () => void shutdown(0));
  onSignal('SIGTERM', () => void shutdown(0));
  // A supervisor whose launcher is gone stops its Station: the launcher's
  // replacement starts from service-state.json, never beside it.
  const launcherLink =
    dependencies.launcherLink !== undefined
      ? dependencies.launcherLink
      : processServiceLauncherLink(handOffServiceLiveness, () => {
          void shutdown(0);
        });

  const waitForOwnershipPoll = (delayMs: number): Promise<void> =>
    new Promise((resolve) => {
      wakeOwnershipWait = () => {
        wakeOwnershipWait = undefined;
        resolve();
      };
      timer = setTimer(wakeOwnershipWait, delayMs);
    });

  // KeepAlive/Restart=always must not turn contention into an exit loop.
  // Only a won atomic claim licenses startup; an unreadable registry still
  // fails closed. Waiting does not stop or probe another owner's Station.
  const awaitHostClaim = async (): Promise<boolean> => {
    let lastRefusal: string | undefined;
    let delayMs = CHECK_INTERVAL_MS;
    while (!shuttingDown) {
      const claim = claimHost();
      if (claim.won) {
        if (lastRefusal) {
          console.log(
            `Station service '${instanceName}' acquired its home; starting Station.`,
          );
        }
        return true;
      }
      const reason =
        claim.reason === 'host-owned'
          ? describeServiceHostRefusal(livenessTarget, claim.owners)
          : `Station service '${instanceName}' cannot claim its registry id: it is held by a live '${claim.existing.type}' process. Stop that process or use a different instance name.`;
      if (reason !== lastRefusal) {
        console.error(`${reason} Waiting for ownership.`);
        lastRefusal = reason;
      }
      launcherLink?.tick();
      if (shuttingDown) break;
      await waitForOwnershipPoll(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
    }
    return false;
  };

  let expected: CollectedInstanceStatus;
  const claimAndStart = async (): Promise<boolean> => {
    while (!shuttingDown) {
      try {
        if (!(await awaitHostClaim()) || shuttingDown) return false;
      } catch (error) {
        console.error(
          `Station service could not claim its home in the registry: ${(error as Error).message}`,
        );
        exit(1);
        return false;
      }

      try {
        // station#1869: a supervised service (launchd/systemd KeepAlive) cannot
        // "warn and reuse a stale build" the way an interactive `start` does — a
        // stale build that crashes on boot sends the supervisor into a restart
        // loop because KeepAlive respawns it. When the build is stale, BUILD
        // instead. This mirrors what a developer running `./station start --build`
        // gets, and the prune in `buildApplication` clears any orphan candidate
        // dirs a previous killed-mid-build supervisor left behind.
        const buildIfStale = needsBuildForInstance(instanceName);
        generation = null;
        startPromise = startInstance({
          onSpawned: (spawned) => {
            generation = spawned;
          },
          allowedOrigins: lifecycle.allowedOrigins,
          // The host-owner claim above already fences this home. The CLI's
          // advisory shared-home warning is separate from that atomic decision.
          allowSharedHome: true,
          baseDir: lifecycle.baseDir,
          build: buildIfStale,
          features: lifecycle.features,
          force: true,
          homeSource: lifecycle.homeSource,
          host: lifecycle.host ?? '127.0.0.1',
          instanceName,
          logFile: join(lifecycle.baseDir, 'logs', `${instanceName}.log`),
          serverPort: lifecycle.serverPort,
          supervisorPid: process.pid,
          uiPort: lifecycle.uiPort,
        });
        await startPromise;
      } catch (error) {
        if (shuttingDown) {
          await shutdownPromise;
          return false;
        }
        consecutiveSupervisorFailures += 1;
        const delay = Math.min(
          30_000,
          5_000 * 2 ** (consecutiveSupervisorFailures - 1),
        );
        console.error(
          `Station service start failed; exiting after ${delay}ms:`,
          error,
        );
        await new Promise<void>((resolve) => setTimer(resolve, delay));
        await shutdown(1);
        return false;
      }

      if (shuttingDown) {
        await shutdownPromise;
        return false;
      }

      expected = await collect(instanceName, {
        probeTimeoutMs: STEADY_PROBE_TIMEOUT_MS,
        // A prebuilt archive keeps the record in this home's root (#2675).
        projectHome: lifecycle.baseDir,
      });
      if (!expected.found || !expected.bootId || !expected.sha) {
        console.error(
          'Station service did not publish a managed instance record',
        );
        await shutdown(1);
        return false;
      }
      console.log(
        `Supervising Station ${expected.sha} (boot ${expected.bootId})`,
      );
      // Readiness is proven: mark the record running (#3064). The host claim
      // above already fenced the home with this supervisor's pid as `starting`
      // unless another live process of this unit (an update's launcher, a
      // replaced generation) still held it; this write takes it over.
      try {
        publishServiceLiveness(true);
      } catch (error) {
        console.error(
          `Station service lost its home ownership fence: ${(error as Error).message}`,
        );
        recoveringOwnership = true;
        try {
          await stopOwnedGeneration();
        } catch (stopError) {
          console.error('Station service cleanup failed:', stopError);
          await shutdown(1);
          return false;
        }
        startPromise = undefined;
        publishServiceLiveness(false);
        if (shuttingDown) return false;
        // Also bound retries if publication failed because the registry is
        // temporarily unwritable rather than because a live owner appeared.
        await waitForOwnershipPoll(CHECK_INTERVAL_MS);
        continue;
      }
      return true;
    }
    return false;
  };

  /**
   * Decide, per child, whether a failed identity probe is evidence of death
   * or only of slowness (station#1846). The child's PROCESS is already known
   * to be alive when this runs — teardown therefore requires positive
   * evidence: a foreign identity answering on the port, a definitively
   * refused socket, or sustained unresponsiveness that survives a
   * long-budget confirmation probe. Transient slowness only warns.
   */
  const authEscalationLedgerPath = join(
    lifecycle.baseDir,
    'logs',
    `${instanceName}.auth-escalations.json`,
  );
  const readAuthEscalations = (): number[] => {
    try {
      const parsed = JSON.parse(readFileSync(authEscalationLedgerPath, 'utf8'));
      return Array.isArray(parsed)
        ? parsed.filter((entry) => Number.isInteger(entry))
        : [];
    } catch {
      return [];
    }
  };
  const recentAuthEscalations = (): number[] =>
    readAuthEscalations().filter((stamp) => {
      const age = now() - stamp;
      return age >= 0 && age <= AUTH_ESCALATION_LOOP_WINDOW_MS;
    });
  const recordAuthEscalation = (): void => {
    try {
      writeFileSync(
        authEscalationLedgerPath,
        JSON.stringify([...recentAuthEscalations(), now()].slice(-10)),
      );
    } catch {
      // Damping degrades to per-process only; never block the escalation.
    }
  };

  const evaluateChildHealth = async (
    name: 'server' | 'ui',
    child: CollectedChildStatus,
  ): Promise<void> => {
    const state = childState[name];
    if (child.probe === 'ok') {
      // A fast healthy gap does not erase earlier long-budget rescues.
      resetChildProbeState(name);
      return;
    }
    if (child.probe === 'identity-mismatch') {
      state.authRefusalSinceMs = undefined;
      state.authRefusalStrikes = 0;
      state.identityMismatchStrikes += 1;
      // A mismatch answer is ALSO positive evidence our child did not answer,
      // so the continuous-failure window keeps accumulating: an intermittent
      // foreign responder (mismatch and unreachable alternating) must drain
      // through the escalation backstop, not reset it (review round 1, MED 1).
      // listenerGoneStrikes DOES reset — an HTTP answer proves a listener.
      state.failingSinceMs ??= now();
      state.listenerGoneStrikes = 0;
      if (state.identityMismatchStrikes >= IDENTITY_MISMATCH_TEARDOWN_STRIKES) {
        throw new Error(
          `Station ${name} identity endpoint reports a different Station on its port`,
        );
      }
      console.warn(
        `Station ${name} identity probe answered with a different identity (${state.identityMismatchStrikes}/${IDENTITY_MISMATCH_TEARDOWN_STRIKES})`,
      );
      return;
    }
    if (child.probe === 'http-auth-refused') {
      state.failingSinceMs ??= now();
      // Consecutiveness is per-cause: an auth refusal is a different,
      // definitive signal — interleaved mismatch/listener evidence must not
      // accumulate across it (sol review of #2669, finding 3).
      state.identityMismatchStrikes = 0;
      state.listenerGoneStrikes = 0;
      state.authRefusalSinceMs ??= now();
      state.authRefusalStrikes += 1;
      const refusedForMs = now() - state.authRefusalSinceMs;
      if (
        state.authRefusalStrikes >= AUTH_REFUSAL_TEARDOWN_STRIKES &&
        refusedForMs >= AUTH_REFUSAL_ESCALATION_MS
      ) {
        if (recentAuthEscalations().length >= AUTH_ESCALATION_LOOP_CAP) {
          // The wedge survived restarts — another teardown would only loop.
          console.error(
            `Station ${name} authentication wedge persists across ${AUTH_ESCALATION_LOOP_CAP}+ restarts; automatic recovery suspended — run 'station doctor' (probe stays refused, service left running for direct callers)`,
          );
          return;
        }
        recordAuthEscalation();
        throw new Error(
          `Station ${name} identity endpoint refused its credential (${state.authRefusalStrikes} consecutive HTTP 401/403 responses over ${Math.round(refusedForMs / 1000)}s); treating it as a supervisor authentication wedge`,
        );
      }
      console.warn(
        `Station ${name} identity endpoint refused its credential (${state.authRefusalStrikes}/${AUTH_REFUSAL_TEARDOWN_STRIKES}); awaiting sustained-auth escalation`,
      );
      return;
    }
    // probe === 'unreachable': decide slow-vs-dead from the socket, not the
    // HTTP round-trip.
    state.authRefusalSinceMs = undefined;
    state.authRefusalStrikes = 0;
    state.failingSinceMs ??= now();
    const failingForMs = now() - state.failingSinceMs;
    // The escalation backstop runs first so it drains EVERY sustained non-ok
    // state — including ones whose per-tick strike counters keep getting
    // reset by interleaved observations (review round 1, MED 1).
    if (failingForMs >= UNRESPONSIVE_ESCALATION_MS) {
      console.warn(
        `Station ${name} identity probe has failed continuously for ${Math.round(failingForMs / 1000)}s; running a ${CONFIRMATION_PROBE_TIMEOUT_MS / 1000}s confirmation probe`,
      );
      const confirmation = await collect(instanceName, {
        probeTimeoutMs: CONFIRMATION_PROBE_TIMEOUT_MS,
        // A prebuilt archive keeps the record in this home's root (#2675).
        projectHome: lifecycle.baseDir,
      });
      if (confirmation.found && confirmation[name].probe === 'ok') {
        // station#1846: a single long-budget recovery proves a working child
        // and must not destroy it. A chronic rescue child is different: cap
        // warn -> confirm -> recover cycles instead of tolerating forever.
        const recoveredAt = now();
        state.recoveryTimestamps = state.recoveryTimestamps.filter(
          (timestamp) => timestamp >= recoveredAt - RECOVERY_CYCLE_WINDOW_MS,
        );
        state.recoveryTimestamps.push(recoveredAt);
        if (state.recoveryTimestamps.length > RECOVERY_CYCLE_CAP) {
          throw new Error(
            `Station ${name} required ${state.recoveryTimestamps.length} confirmation-probe recoveries within ${RECOVERY_CYCLE_WINDOW_MS / 60_000} minutes`,
          );
        }
        resetChildProbeState(name);
        console.warn(
          `Station ${name} recovered on the confirmation probe; continuing`,
        );
        return;
      }
      throw new Error(
        `Station ${name} failed identity probes continuously for ${Math.round(failingForMs / 1000)}s and a final ${CONFIRMATION_PROBE_TIMEOUT_MS / 1000}s confirmation probe; treating it as wedged`,
      );
    }
    if (!child.listening) {
      state.identityMismatchStrikes = 0;
      state.listenerGoneStrikes += 1;
      if (state.listenerGoneStrikes >= LISTENER_GONE_TEARDOWN_STRIKES) {
        throw new Error(
          `Station ${name} process is alive but its port refused ${LISTENER_GONE_TEARDOWN_STRIKES} consecutive connections`,
        );
      }
      console.warn(
        `Station ${name} port refused a connection (${state.listenerGoneStrikes}/${LISTENER_GONE_TEARDOWN_STRIKES})`,
      );
      return;
    }
    state.listenerGoneStrikes = 0;
    const listeningPids = listListeningPids(
      name === 'server' ? lifecycle.serverPort : lifecycle.uiPort,
    );
    if (
      listeningPids.length > 0 &&
      (child.pid === null || !listeningPids.includes(child.pid))
    ) {
      state.identityMismatchStrikes += 1;
      if (state.identityMismatchStrikes >= IDENTITY_MISMATCH_TEARDOWN_STRIKES) {
        throw new Error(
          `Station ${name} port is owned by a foreign listener instead of its recorded child`,
        );
      }
      console.warn(
        `Station ${name} identity probe failed and port is owned by foreign pid(s) ${listeningPids.join(', ')} (${state.identityMismatchStrikes}/${IDENTITY_MISMATCH_TEARDOWN_STRIKES})`,
      );
      return;
    }
    // collectInstanceStatus deliberately omits persisted process fingerprints,
    // so a recycled PID can pass this early ownership check. The 180s
    // confirmation path remains the backstop until that status contract can
    // expose authenticated fingerprint evidence without new plumbing here.
    state.identityMismatchStrikes = 0;
    console.warn(
      `Station ${name} identity probe failed for ${Math.round(failingForMs / 1000)}s; process alive and port listening — tolerating (slow is not dead)`,
    );
  };

  const check = async () => {
    if (shuttingDown) return;
    let owned = true;
    try {
      owned = ownsHost();
    } catch (error) {
      // An unreadable registry is not positive evidence of ownership loss.
      // Keep serving and retry on the next existing health tick.
      console.warn(
        `Station service could not verify its home ownership; continuing until a successful read: ${(error as Error).message}`,
      );
    }
    if (!owned) {
      console.error(
        `Station service '${instanceName}' lost its home ownership fence; stopping Station and waiting for ownership.`,
      );
      recoveringOwnership = true;
      await stopOwnedGeneration();
      startPromise = undefined;
      publishServiceLiveness(false);
      resetChildProbeState('server');
      resetChildProbeState('ui');
      childState.server.recoveryTimestamps = [];
      childState.ui.recoveryTimestamps = [];
      if (shuttingDown) return;
      await waitForOwnershipPoll(CHECK_INTERVAL_MS);
      if (!(await claimAndStart())) return;
      if (shuttingDown) return;
    }
    const current = await collect(instanceName, {
      probeTimeoutMs: STEADY_PROBE_TIMEOUT_MS,
      // A prebuilt archive keeps the record in this home's root (#2675).
      projectHome: lifecycle.baseDir,
    });
    if (shuttingDown) return;
    if (!current.found || !sameBoot(current, expected)) {
      throw new Error(
        'Managed Station identity changed outside the supervisor',
      );
    }
    for (const name of ['server', 'ui'] as const) {
      const pid = current[name].pid;
      if (typeof pid !== 'number' || !processIsAlive(pid)) {
        throw new Error(`Managed Station ${name} child process exited`);
      }
    }
    for (const name of ['server', 'ui'] as const) {
      await evaluateChildHealth(name, current[name]);
    }
    if (!shuttingDown) desktopCompanion.check();
    if (!shuttingDown) launcherLink?.tick();
    if (shuttingDown) return;
    timer = setTimer(() => {
      void check().catch((error) => {
        console.error('Station supervisor failed:', error);
        void shutdown(1);
      });
    }, CHECK_INTERVAL_MS);
  };

  if (!(await claimAndStart())) return;
  if (shuttingDown) return;
  // A trial reports prepared only once, with its identity proven.
  launcherLink?.onReady();

  await check().catch(async (error) => {
    console.error('Station supervisor failed:', error);
    await shutdown(1);
  });
}
