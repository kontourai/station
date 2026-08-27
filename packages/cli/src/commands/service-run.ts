import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as setNodeTimeout } from 'node:timers';
import { updateOwnedInstance } from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import {
  type CollectedChildStatus,
  type CollectedInstanceStatus,
  collectInstanceStatus,
  findListeningPidsForPorts,
  isBuildStale,
  resolveBuildPaths,
  start,
  stop,
} from './lifecycle.js';
import type { ServiceLifecycleArgs } from './service.js';

export interface SupervisorDependencies {
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
const SHUTDOWN_DEADLINE_MS = 60_000;

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
  const startInstance = dependencies.start ?? start;
  const stopInstance = dependencies.stop ?? stop;
  const collect = dependencies.collect ?? collectInstanceStatus;
  const needsBuildForInstance =
    dependencies.needsBuildForInstance ??
    ((name: string) => isBuildStale(resolveBuildPaths(name)));
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const publishServiceLiveness =
    dependencies.publishServiceLiveness ??
    ((live: boolean) => {
      // ONE-OWNER SIGNAL (station#3064). Desktop refuses to spawn its own
      // sidecar onto a home a live service owns — `decide_home_ownership`
      // selects on a service-typed entry with a LIVE pid. Nothing ever wrote
      // one: `service install` records policy without liveness (correctly —
      // it is not the running process), and this supervisor's inner start()
      // is refused by the CLI producer's protected-type guard. So the branch
      // was unreachable and Desktop spawned a second server onto a
      // service-owned home, which is the multi-writer condition #2904 exists
      // to prevent.
      //
      // The supervisor is the right publisher: it is the process launchd or
      // systemd keeps alive, and it outlives the server children it
      // restarts, so the record does not flap. An UPDATE, never a claim: the
      // entry's `env.ALLOWED_ORIGINS` is durable origin-policy authority
      // (#1983) and must survive every liveness write. Own-type only, so a
      // bare `service run` with no install does not mint an entry the
      // installer owns (disclosed limit: such a run stays invisible
      // home-wide).
      try {
        // Probe OUTSIDE the mutation lock: the lookup spawns `ps` (or
        // powershell on Windows) with a 1.5s timeout, and holding the
        // home-wide lock across that stalls every other writer, including
        // the Desktop sidecar claim. Every sibling producer resolves its
        // fingerprint before taking the lock.
        const birth = live
          ? (lookupProcessBirthFingerprint(process.pid) ?? undefined)
          : undefined;
        updateOwnedInstance(
          instanceName,
          { home: lifecycle.baseDir, ownTypes: ['service'] },
          (existing) => {
            if (!live) {
              // IDENTITY-GUARDED RETRACT. A retiring generation must never
              // clear a NEWER supervisor's record: reinstall-over-a-live-
              // service is a path this change deliberately unblocks, so A's
              // exit can overlap B's boot. Clearing B's pid would tell
              // Desktop that no service owns the home while B is serving it,
              // and Desktop would spawn a second writer — the exact
              // condition this signal exists to prevent. It does not
              // self-heal: B publishes once, at readiness.
              if (existing.pid !== process.pid) return null;
              return {
                ...existing,
                status: 'stopped',
                pid: undefined,
                birth: undefined,
              };
            }
            return {
              ...existing,
              port: lifecycle.serverPort,
              uiPort: lifecycle.uiPort,
              status: 'running',
              pid: process.pid,
              birth,
            };
          },
        );
      } catch (error) {
        // Best-effort, exactly like the CLI producer: a registry that cannot
        // be written must never take down a supervised unit.
        console.error(
          `Station service could not record its liveness in the home registry: ${(error as Error).message}`,
        );
      }
    });
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
  let shutdownPromise: Promise<void> | undefined;
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
    const forceExitTimer = setTimer(() => {
      console.error(
        `Station service shutdown exceeded ${SHUTDOWN_DEADLINE_MS / 1000}s; forcing exit`,
      );
      exit(1);
    }, SHUTDOWN_DEADLINE_MS);
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
      // Wait for that in-flight transaction to settle, then stop by record so a
      // signal cannot strand children in the publication window.
      await startPromise?.catch(() => undefined);
      try {
        await stopInstance({ instanceName });
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

  try {
    // station#1869: a supervised service (launchd/systemd KeepAlive) cannot
    // "warn and reuse a stale build" the way an interactive `start` does — a
    // stale build that crashes on boot sends the supervisor into a restart
    // loop because KeepAlive respawns it. When the build is stale, BUILD
    // instead. This mirrors what a developer running `./station start --build`
    // gets, and the prune in `buildApplication` clears any orphan candidate
    // dirs a previous killed-mid-build supervisor left behind.
    const buildIfStale = needsBuildForInstance(instanceName);
    startPromise = startInstance({
      allowedOrigins: lifecycle.allowedOrigins,
      // PRODUCT DECISION (station#2904 2b, recorded per review): a supervised
      // unit does not refuse on a shared home. Its home was chosen at install
      // time; a run-time refusal here throws into superviseService's failure
      // counter and becomes a launchd/systemd restart-backoff LOOP — strictly
      // worse than the coexistence it would be objecting to, and this path
      // has no operator at a terminal to pass an override. The shared-home
      // warning still prints at the exits, so the condition stays audible.
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
      return;
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
    return;
  }

  if (shuttingDown) {
    await shutdownPromise;
    return;
  }

  const expected = await collect(instanceName, {
    probeTimeoutMs: STEADY_PROBE_TIMEOUT_MS,
  });
  if (!expected.found || !expected.bootId || !expected.sha) {
    console.error('Station service did not publish a managed instance record');
    await shutdown(1);
    return;
  }
  console.log(`Supervising Station ${expected.sha} (boot ${expected.bootId})`);
  // Only now: readiness is proven, mirroring #1983's rule that durable
  // records follow the fallible operation rather than precede it.
  publishServiceLiveness(true);

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
    const current = await collect(instanceName, {
      probeTimeoutMs: STEADY_PROBE_TIMEOUT_MS,
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
    if (shuttingDown) return;
    timer = setTimer(() => {
      void check().catch((error) => {
        console.error('Station supervisor failed:', error);
        void shutdown(1);
      });
    }, CHECK_INTERVAL_MS);
  };

  await check().catch(async (error) => {
    console.error('Station supervisor failed:', error);
    await shutdown(1);
  });
}
