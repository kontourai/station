import {
  type ExactProcessIdentityProbe,
  type ProcessIdentityDependencies,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import {
  emitRestartDiagnostic,
  type RestartStateWriteResult,
  type SelfUpdateRestartFailureCode,
  type SelfUpdateRestartRecord,
} from './self-update-restart-state.js';

export interface SelfUpdateWatchdogParams {
  pid: number;
  port: number;
  /** Short (7-char) sha the new server must report via /api/system/status's `build.shortSha`. */
  hash: string;
  instanceId: string;
  startedAt: string;
  host?: string;
  deadlineMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  killGraceMs?: number;
}

interface HealthResponse {
  status: number;
  json: () => Promise<unknown>;
}

type HealthFetch = (
  url: string,
  signal: AbortSignal,
) => Promise<HealthResponse>;

export interface SelfUpdateWatchdogDeps {
  fetchImpl?: HealthFetch;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for the shared, platform-specific process-identity probe. */
  processIdentityDeps?: ProcessIdentityDependencies;
  writeRecord: (
    record: SelfUpdateRestartRecord,
  ) => RestartStateWriteResult | undefined;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

// Same MEASUREMENT as packages/cli/src/commands/lifecycle.ts's
// STARTUP_READINESS_TIMEOUT_MS (archive#1903) — cold starts are roughly 5.5s
// unloaded, but provider discovery on a busy host can exceed 60s — but since
// archive#2646 it is no longer the same BUDGET, and this comment used to say it was.
//
// That base can now extend to STARTUP_READINESS_MAX_TIMEOUT_MS (180s) for a
// caller that supplies a `childAlive` probe. This watchdog is not such a
// caller: it polls health itself, so its 90s is a hard ceiling. A self-update
// restart whose boot needs the extended window is therefore reported failed
// here while `station start` would still be waiting on it. Deliberate for now
// (an unbounded watchdog is worse than a strict one), and recorded rather
// than left as a comment asserting a parity that no longer holds.
export const SELF_UPDATE_WATCHDOG_DEADLINE_MS = 90_000;
/**
 * The parent records restart intent before its delayed child/watchdog spawn.
 * Give clients enough time to observe the watchdog's own 90-second budget,
 * including that deliberate launch hand-off, without inventing a second
 * unbounded client timer.
 */
export const SELF_UPDATE_WATCHDOG_LAUNCH_GRACE_MS = 5_000;
export const SELF_UPDATE_WATCHDOG_POLL_INTERVAL_MS = 1_000;
export const SELF_UPDATE_WATCHDOG_REQUEST_TIMEOUT_MS = 3_000;
export const SELF_UPDATE_WATCHDOG_KILL_GRACE_MS = 5_000;

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function assertWatchdogPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Self-update watchdog requires a positive server pid');
  }
}

const defaultFetchImpl: HealthFetch = (url, signal) => fetch(url, { signal });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function healthCheckUrl(host: string, port: number): string {
  return `http://${host}:${port}/api/system/status`;
}

type ProbeOutcome =
  | { kind: 'healthy' }
  | { kind: 'unreachable' }
  | { kind: 'identity-mismatch' };

/**
 * A single bounded health-probe attempt: connect, and if — and only if — the
 * body's OWN reported build identity matches the server we spawned, count it
 * healthy. A 200 alone is not enough (archive#1903 review finding 1): the
 * incident named in the design doc was a server that bound the port and
 * held it while answering nothing, but the class of bug this guards against
 * is broader — a NEW build that crashes on boot could free the port for an
 * auto-respawned OLD build, or for anything else that happens to answer on
 * it, and a bare status check would read that as a successful update.
 * Mirrors `waitForIdentity` in packages/cli/src/commands/lifecycle.ts, which
 * round-trips instanceId/sha/bootId over the same kind of probe for the
 * same reason.
 */
async function probeOnce(
  healthUrl: string,
  expected: { hash: string; instanceId: string },
  remainingMs: number,
  requestTimeoutMs: number,
  fetchImpl: HealthFetch,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const attemptTimedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort();
          reject(new Error('self-update watchdog: health probe timed out'));
        },
        Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
      );
    });
    const response = await Promise.race([
      fetchImpl(healthUrl, controller.signal),
      attemptTimedOut,
    ]);
    if (response.status !== 200) return { kind: 'unreachable' };
    // The body read is ALSO raced against the deadline — a response that
    // answers the status line but stalls streaming its body is no different
    // from one that never answered at all.
    const body = (await Promise.race([response.json(), attemptTimedOut])) as {
      build?: { shortSha?: unknown; instanceId?: unknown };
    };
    const observedShortSha = body.build?.shortSha;
    const observedInstanceId = body.build?.instanceId;
    if (
      observedShortSha === expected.hash &&
      observedInstanceId === expected.instanceId
    ) {
      return { kind: 'healthy' };
    }
    return { kind: 'identity-mismatch' };
  } catch {
    // Unreachable, refused, or timed out this attempt — a socket that
    // accepted the connection but never answered looks exactly like this.
    return { kind: 'unreachable' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface PollResult {
  healthy: boolean;
  failureCode?: Extract<
    SelfUpdateRestartFailureCode,
    'health-unreachable' | 'identity-mismatch'
  >;
}

/**
 * Polls `healthUrl` until it answers 200 WITH the expected build identity,
 * or `deadline` (an absolute `Date.now()`-comparable timestamp) passes.
 */
async function pollUntilHealthy(
  healthUrl: string,
  expected: { hash: string; instanceId: string },
  deadline: number,
  pollIntervalMs: number,
  requestTimeoutMs: number,
  fetchImpl: HealthFetch,
): Promise<PollResult> {
  let sawIdentityMismatch = false;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const outcome = await probeOnce(
      healthUrl,
      expected,
      remainingMs,
      requestTimeoutMs,
      fetchImpl,
    );
    if (outcome.kind === 'healthy') return { healthy: true };
    if (outcome.kind === 'identity-mismatch') sawIdentityMismatch = true;
    const retryDelayMs = Math.min(
      pollIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return {
    healthy: false,
    failureCode: sawIdentityMismatch
      ? 'identity-mismatch'
      : 'health-unreachable',
  };
}

/**
 * Terminates a process that never proved healthy so it cannot sit holding
 * the port while serving nothing (tonight's actual failure mode). SIGTERM
 * first, bounded grace period, then SIGKILL only if it is still alive.
 */
async function terminate(
  pid: number,
  registeredIdentity: ExactProcessIdentityProbe,
  killGraceMs: number,
  killProcess: (pid: number, signal: NodeJS.Signals) => void,
  processIdentityDeps: ProcessIdentityDependencies | undefined,
): Promise<TerminationObservation> {
  const observe = (): ChildObservation => {
    const observed = probeExactProcessIdentity(pid, processIdentityDeps);
    if (registeredIdentity.state === 'dead' || observed.state === 'dead') {
      return 'gone';
    }
    if (registeredIdentity.state === 'unavailable') {
      // We could not capture an identity at registration, so preserve the
      // watchdog's pre-identity behavior: signal a live PID on liveness alone.
      // This has the established PID-reuse risk, but refusing to terminate
      // would silently remove recovery on hosts that cannot fingerprint.
      return 'alive';
    }
    // Once registration captured an exact birth fingerprint, fail closed: an
    // unavailable or different live PID must never receive a signal.
    return observed.state === 'exact' &&
      observed.identity.start === registeredIdentity.identity.start
      ? 'alive'
      : 'unknown';
  };

  const initial = observe();
  if (initial === 'gone') return { kind: 'gone-before-signalling' };
  if (initial === 'unknown')
    return { kind: 'identity-blocked-before-signalling' };

  try {
    killProcess(pid, 'SIGTERM');
  } catch {
    return { kind: 'sigterm-failed', final: observe() };
  }
  const killDeadline = Date.now() + killGraceMs;
  let identityBlocked = false;
  while (Date.now() < killDeadline) {
    const duringGrace = observe();
    if (duringGrace !== 'alive') {
      identityBlocked = duringGrace === 'unknown';
      break;
    }
    await sleep(Math.min(200, Math.max(0, killDeadline - Date.now())));
  }
  let sigkillFailed = false;
  let sigkillSent = false;
  if (!identityBlocked && observe() === 'alive') {
    try {
      killProcess(pid, 'SIGKILL');
      sigkillSent = true;
    } catch {
      sigkillFailed = true;
    }
  }
  return {
    kind: identityBlocked
      ? 'identity-blocked-after-sigterm'
      : sigkillFailed
        ? 'sigkill-failed'
        : 'signalled',
    verification:
      registeredIdentity.state === 'unavailable' ? 'unverified' : 'verified',
    sigkillSent,
    final: observe(),
  };
}

type ChildObservation = 'gone' | 'alive' | 'unknown';

type TerminationObservation =
  | { kind: 'gone-before-signalling' }
  | { kind: 'identity-blocked-before-signalling' }
  | { kind: 'sigterm-failed'; final: ChildObservation }
  | {
      kind: 'signalled' | 'sigkill-failed' | 'identity-blocked-after-sigterm';
      verification: 'verified' | 'unverified';
      sigkillSent: boolean;
      final: ChildObservation;
    };

function terminationDiagnostic(termination: TerminationObservation): string {
  const verification =
    termination.kind !== 'gone-before-signalling' &&
    termination.kind !== 'identity-blocked-before-signalling' &&
    termination.kind !== 'sigterm-failed'
      ? termination.verification === 'verified'
        ? ' after verified identity'
        : ' without identity verification because this host could not fingerprint the process'
      : '';
  const observed =
    'final' in termination
      ? termination.final === 'gone'
        ? ' the watched child was observed gone before the watchdog stopped looking'
        : termination.final === 'alive'
          ? ' the watched child was still alive when the watchdog stopped looking'
          : ' the watched child state could not be confirmed when the watchdog stopped looking'
      : '';

  switch (termination.kind) {
    case 'gone-before-signalling':
      return 'Self-update watchdog: new server failed health verification; watched child was already gone before the watchdog sent a signal';
    case 'identity-blocked-before-signalling':
      return 'Self-update watchdog: new server failed health verification; watched child identity no longer matched or could not be verified, so no signal was sent';
    case 'sigterm-failed':
      return `Self-update watchdog: new server failed health verification; SIGTERM could not be delivered and${observed}`;
    case 'identity-blocked-after-sigterm':
      return `Self-update watchdog: new server failed health verification; SIGTERM was sent${verification}, SIGKILL was skipped because watched child identity no longer matched or could not be verified, and${observed}`;
    case 'sigkill-failed':
      return `Self-update watchdog: new server failed health verification; SIGTERM was sent${verification}, SIGKILL could not be delivered, and${observed}`;
    case 'signalled':
      return termination.final === 'gone'
        ? `Self-update watchdog: new server failed health verification; watched child was observed gone after signalling${verification}`
        : termination.sigkillSent
          ? `Self-update watchdog: new server failed health verification; SIGTERM and SIGKILL were sent${verification}, and${observed}`
          : `Self-update watchdog: new server failed health verification; SIGTERM was sent${verification}, and${observed}`;
  }
}

function terminationDiagnosticContext(termination: TerminationObservation): {
  terminationObserved: ChildObservation;
} {
  return {
    terminationObserved:
      termination.kind === 'gone-before-signalling'
        ? 'gone'
        : termination.kind === 'identity-blocked-before-signalling'
          ? 'unknown'
          : termination.final,
  };
}

/**
 * Runs in a process detached from the parent that spawned the new server —
 * the parent must exit to free the shared port (archive#1903), so nothing
 * inside that process can wait for this. The only signal that counts as
 * healthy is a real 200 from the new server's own status endpoint carrying
 * the EXPECTED build identity (see `probeOnce`): the incident this exists
 * for was a server that bound the port, held the socket open, and never
 * answered a single request — a port-bind, pid-alive, or bare-200 check
 * would all have read that server as fine.
 */
export async function runSelfUpdateWatchdog(
  params: SelfUpdateWatchdogParams,
  deps: SelfUpdateWatchdogDeps,
): Promise<SelfUpdateRestartRecord> {
  assertWatchdogPid(params.pid);
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const host = params.host ?? '127.0.0.1';
  const deadlineMs = params.deadlineMs ?? SELF_UPDATE_WATCHDOG_DEADLINE_MS;
  const pollIntervalMs =
    params.pollIntervalMs ?? SELF_UPDATE_WATCHDOG_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    params.requestTimeoutMs ?? SELF_UPDATE_WATCHDOG_REQUEST_TIMEOUT_MS;
  const killGraceMs = params.killGraceMs ?? SELF_UPDATE_WATCHDOG_KILL_GRACE_MS;
  const healthUrl = healthCheckUrl(host, params.port);
  const deadline = Date.now() + deadlineMs;
  // Capture once, as soon as this detached watchdog receives the spawned
  // child's PID. Looking this up at termination would accept a recycled PID.
  const registeredIdentity = probeExactProcessIdentity(
    params.pid,
    deps.processIdentityDeps,
  );
  const { healthy, failureCode } = await pollUntilHealthy(
    healthUrl,
    { hash: params.hash, instanceId: params.instanceId },
    deadline,
    pollIntervalMs,
    requestTimeoutMs,
    fetchImpl,
  );

  if (healthy) {
    const record: SelfUpdateRestartRecord = {
      instanceId: params.instanceId,
      hash: params.hash,
      pid: params.pid,
      port: params.port,
      startedAt: params.startedAt,
      status: 'verified',
      resolvedAt: new Date().toISOString(),
    };
    const write = deps.writeRecord(record);
    if (write?.durability === 'uncertain') {
      emitRestartDiagnostic(
        deps.logger,
        'warn',
        'Self-update watchdog: restart verdict committed with uncertain directory durability',
        {
          hash: params.hash,
          pid: params.pid,
        },
      );
    }
    emitRestartDiagnostic(
      deps.logger,
      'info',
      'Self-update watchdog: new server answered healthy',
      { hash: params.hash, pid: params.pid },
    );
    return record;
  }

  const termination = await terminate(
    params.pid,
    registeredIdentity,
    killGraceMs,
    killProcess,
    deps.processIdentityDeps,
  );

  const record: SelfUpdateRestartRecord = {
    instanceId: params.instanceId,
    hash: params.hash,
    pid: params.pid,
    port: params.port,
    startedAt: params.startedAt,
    status: 'failed',
    resolvedAt: new Date().toISOString(),
    failureCode: failureCode ?? 'health-unreachable',
  };
  const write = deps.writeRecord(record);
  if (write?.durability === 'uncertain') {
    emitRestartDiagnostic(
      deps.logger,
      'warn',
      'Self-update watchdog: restart verdict committed with uncertain directory durability',
      {
        hash: params.hash,
        pid: params.pid,
      },
    );
  }
  emitRestartDiagnostic(
    deps.logger,
    'error',
    terminationDiagnostic(termination),
    {
      hash: params.hash,
      pid: params.pid,
      ...terminationDiagnosticContext(termination),
    },
  );
  return record;
}
