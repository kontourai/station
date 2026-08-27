#!/usr/bin/env node

/**
 * Opt-in coordinator conformance. The default command is dry. `--run` creates
 * only a disposable Git repository and two worktrees beneath one mkdtemp root.
 * Its single deadline starts before mkdtemp and reserves time for settlement
 * and cleanup; an unprovable cleanup retains the exact root for inspection.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVerificationToolchain } from './lib/test-reliability.mjs';
import {
  __verificationCoordinatorInternals,
  coordinateVerification,
  executionEquivalenceKey,
  verificationStatus,
} from './lib/verification-coordinator.mjs';
import { createVerificationRequest } from './lib/verification-receipt.mjs';
import { verifyVerificationArtifacts } from './lib/verification-reporter.mjs';

export const STRESS_LIMITS = Object.freeze({
  maxWorktrees: 2,
  maxFixtureProcesses: 8,
  maxDurationMs: 10_000,
  cleanupReserveMs: 1_000,
  laneTimeoutMs: 800,
  maxOutputBytes: 1_024,
  // station#1804. Floor for the timeout scenario's deadline, and the multiple
  // of this run's *own* observed admission latency it is scaled by. See
  // timeoutScenarioBudgetMs below for why a bare constant was the defect.
  minTimeoutHeadroomMs: 100,
  admissionHeadroomFactor: 8,
});

/**
 * Deadline for the scenario that proves an admitted runner records a
 * `timed_out` receipt (station#1804).
 *
 * ## The defect this replaces
 *
 * That scenario used a fixed 100 ms deadline, and the deadline clock starts
 * when the request is *submitted*, not when its runner starts. So the 100 ms
 * had to cover the coordinator's admission handshake as well as the overrun it
 * meant to measure. When admission alone exceeded it, the request expired
 * **before admission** and the coordinator recorded `infrastructure_error`, not
 * `timed_out` — the assertion failed for a reason that had nothing to do with
 * what it was testing.
 *
 * Measured on this host with the constant swept (5 conformance runs per value,
 * minimum value that passed 5/5):
 *
 * | condition                          | 1-min load | minimum passing deadline |
 * | ---------------------------------- | ---------- | ------------------------ |
 * | no other vitest processes          | 17.1       | 25 ms                    |
 * | 8 concurrent vitest processes      | 35.7       | 50 ms                    |
 *
 * The handshake budget doubled under concurrent vitest, which is the same
 * finding station#1804 records from the other direction: the run that went red
 * during #1686 executed at *lower* aggregate load than the run that passed, so
 * the pressure that matters is concurrent vitest and lease contention, not CPU.
 * A larger constant would only move the cliff to a contention level nobody has
 * measured yet, which is why the value is derived here instead: the floor is
 * the old constant, and above it the budget scales with the admission latency
 * this very run just observed. The result is still clamped by
 * `laneTimeoutMs` (800 ms) and by the remaining scenario budget.
 */
export function timeoutScenarioBudgetMs(
  observedAdmissionMs,
  limits = STRESS_LIMITS,
) {
  const observed = Number.isFinite(observedAdmissionMs)
    ? Math.max(0, observedAdmissionMs)
    : 0;
  return Math.max(
    limits.minTimeoutHeadroomMs,
    Math.ceil(observed * limits.admissionHeadroomFactor),
  );
}

const TEMP_PREFIX = 'station-verification-stress-';
const CLEANUP_SCHEDULING_SLACK_MS = 25;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(`verification stress failed: ${message}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function deadlineError() {
  return new Error('verification stress scenario deadline elapsed');
}

/**
 * Settles with the input promise or an enforced timeout, always releasing the
 * losing timer. A bare Promise.race leaves that timer referenced until expiry,
 * which can keep this short-lived CLI alive after every scenario has finished.
 */
export function boundedPromise(
  promise,
  milliseconds,
  message,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let timer;
    const finish = (settler, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      settler(value);
    };
    timer = setTimer(
      () => finish(rejectResult, new Error(message)),
      Math.max(1, milliseconds),
    );
    Promise.resolve(promise).then(
      (value) => finish(resolveResult, value),
      (error) => finish(rejectResult, error),
    );
  });
}

export function createStressContext({
  limits = STRESS_LIMITS,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const totalDeadlineAt = startedAt + limits.maxDurationMs;
  const scenarioDeadlineAt = totalDeadlineAt - limits.cleanupReserveMs;
  const controller = new AbortController();
  return {
    limits,
    now,
    startedAt,
    totalDeadlineAt,
    scenarioDeadlineAt,
    controller,
    tracker: { count: 0, children: [] },
    remainingScenario() {
      return Math.max(0, scenarioDeadlineAt - now());
    },
    remainingCleanup() {
      return Math.max(0, totalDeadlineAt - now());
    },
    assertScenarioTime() {
      if (controller.signal.aborted || now() >= scenarioDeadlineAt)
        throw deadlineError();
    },
  };
}

function runWithScenarioDeadline(context, promise) {
  const remaining = context.remainingScenario();
  if (remaining < 1) return Promise.reject(deadlineError());
  return boundedPromise(
    promise,
    remaining,
    'verification stress scenario deadline elapsed',
  );
}

async function waitScenario(context, milliseconds) {
  context.assertScenarioTime();
  await boundedPromise(
    delay(Math.min(milliseconds, context.remainingScenario())),
    context.remainingScenario(),
    'verification stress scenario deadline elapsed',
  );
  context.assertScenarioTime();
}

async function waitForScenario(context, predicate) {
  while (!predicate()) await waitScenario(context, 5);
}

function fixtureTimeout(context) {
  context.assertScenarioTime();
  return Math.max(
    1,
    Math.min(context.limits.laneTimeoutMs, context.remainingScenario()),
  );
}

function cleanupBudget(context) {
  return Math.max(1, context.remainingCleanup() - CLEANUP_SCHEDULING_SLACK_MS);
}

function runGit(cwd, args, context) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: context.limits.maxOutputBytes,
    timeout: fixtureTimeout(context),
    windowsHide: true,
  });
  context.assertScenarioTime();
  if (result.error || result.status !== 0)
    throw new Error(
      `fixture git ${args.join(' ')} failed: ${result.stderr || result.error?.message || result.status}`,
    );
}

function safeRemoveTemporaryRoot(root) {
  const resolved = resolve(root);
  assert(
    resolved.startsWith(join(tmpdir(), TEMP_PREFIX)),
    'cleanup refused a non-stress temporary root',
  );
  rmSync(resolved, { recursive: true, force: true });
}

export function stressPlan() {
  return {
    mode: 'dry',
    mutatesCurrentWorktree: false,
    requiresExplicitRun: true,
    limits: STRESS_LIMITS,
    checks: [
      'equivalent request single-flight, join, and reuse across two temporary worktrees',
      'weighted queue cancellation and bounded timeout',
      'dead scheduler and owner lease recovery',
      'workspace/provenance invalidation',
      'local receipt artifacts: digest, private mode, and no cross-worktree reclaim',
      'fixture child cleanup with zero surviving owned children',
    ],
  };
}

export function parseStressArgs(args) {
  if (args.length === 0) return { run: false };
  if (args.length === 1 && args[0] === '--run') return { run: true };
  throw new Error('usage: node scripts/run-verification-stress.mjs [--run]');
}

export function fixtureProvenance(fixture, worktree, identity, toolchain) {
  return {
    repositoryId: fixture.repositoryId,
    worktree: resolve(worktree),
    headSha: fixture.headSha,
    workspaceDigest: hash(`workspace:${identity}`),
    environmentDigest: hash('fixture-verification-environment'),
    dependencyDigest: hash('fixture-package-lock'),
    nodeVersion: process.version,
    // A coordinator request key is only meaningful when the staged lease and
    // the execution use the same verified Node/npm pair. Receipt-only tests
    // can use #2079's synthetic identity, but this harness stages a live
    // coordinator lease for recovery, so it binds the executable identity.
    toolchain: toolchain.toolchain,
    toolchainIdentity: toolchain.identity,
    platform: process.platform,
    arch: process.arch,
  };
}

function assertPrivateArtifacts(result, worktree) {
  assert(result.receipt.cleanup.survivingOwnedChildren === 0, 'child survived');
  assert(result.receipt.artifacts.length > 0, 'receipt has no local artifacts');
  assert(
    verifyVerificationArtifacts({
      root: worktree,
      artifacts: result.receipt.artifacts,
    }) === true,
    'artifact verification failed',
  );
  for (const artifact of result.receipt.artifacts) {
    const artifactPath = join(worktree, artifact.path);
    const stat = lstatSync(artifactPath);
    assert(stat.isFile(), `artifact is not a file: ${artifact.path}`);
    if (process.platform !== 'win32')
      assert((stat.mode & 0o777) === 0o600, `artifact mode is not 0600`);
    assert(
      hash(readFileSync(artifactPath)) === artifact.sha256,
      `artifact digest mismatch: ${artifact.path}`,
    );
  }
}

function reserveFixtureProcess(context) {
  if (context.tracker.count >= context.limits.maxFixtureProcesses)
    throw new Error('fixture process cap exceeded');
  context.tracker.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    context.tracker.count -= 1;
  };
}

function trackChild(
  context,
  child,
  { stdout = null, stderr = null, signals = [], releaseReservation } = {},
) {
  let resolveSettlement;
  const record = {
    child,
    pid: child.pid,
    spawned: Number.isInteger(child.pid) && child.pid > 0,
    spawnFailed: false,
    closed: false,
    streamError: null,
    settlement: new Promise((resolveSettlementPromise) => {
      resolveSettlement = resolveSettlementPromise;
    }),
  };
  context.tracker.children.push(record);
  const abortSignals = [context.controller.signal, ...signals].filter(Boolean);
  const onAbort = () => {
    void terminateTrackedChild(context, record);
  };
  child.once('spawn', () => {
    record.spawned = Number.isInteger(child.pid) && child.pid > 0;
    record.pid = child.pid;
  });
  child.stdout?.on('data', stdout ?? (() => {}));
  child.stderr?.on('data', stderr ?? (() => {}));
  child.stdout?.once('error', (error) => {
    record.streamError = error;
  });
  child.stderr?.once('error', (error) => {
    record.streamError = error;
  });
  child.once('error', (error) => {
    record.spawnError = error;
    // A ChildProcess error is only terminal when spawn produced no PID. A
    // successfully spawned child can emit error before its later close event.
    if (!record.spawned && !Number.isInteger(child.pid)) {
      record.spawnFailed = true;
      record.closed = true;
      releaseReservation?.();
      resolveSettlement();
    }
  });
  child.once('close', () => {
    record.closed = true;
    for (const abortSignal of abortSignals)
      abortSignal.removeEventListener('abort', onAbort);
    resolveSettlement();
  });
  for (const abortSignal of abortSignals) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  return record;
}

function spawnTrackedChild(
  context,
  executable,
  args,
  options,
  tracking,
  spawnImpl = spawn,
) {
  const releaseReservation = reserveFixtureProcess(context);
  let child;
  try {
    child = spawnImpl(executable, args, options);
  } catch (error) {
    releaseReservation();
    throw error;
  }
  // The record and its abort listeners are installed immediately after the
  // synchronous spawn return, before any follow-up work can throw.
  const record = trackChild(context, child, {
    ...tracking,
    releaseReservation,
  });
  return { child, record };
}

async function terminateTrackedChild(context, record) {
  if (record.closed) return true;
  try {
    record.child.kill('SIGTERM');
  } catch {
    // The close path below is the authoritative settlement signal.
  }
  const termBudget = Math.max(
    1,
    Math.min(100, Math.floor(cleanupBudget(context) / 2)),
  );
  try {
    await boundedPromise(
      record.settlement,
      termBudget,
      'fixture TERM grace elapsed',
    );
  } catch {
    try {
      record.child.kill('SIGKILL');
    } catch {
      // Closing an already-exited exact child is harmless.
    }
  }
  const killBudget = cleanupBudget(context);
  try {
    await boundedPromise(
      record.settlement,
      killBudget,
      'fixture KILL settlement elapsed',
    );
  } catch {
    return false;
  }
  return record.closed;
}

export async function settleTrackedChildren(context) {
  const outcomes = await Promise.all(
    context.tracker.children.map((record) =>
      terminateTrackedChild(context, record),
    ),
  );
  return (
    outcomes.every(Boolean) &&
    context.tracker.children.every((child) => child.closed)
  );
}

function createFixtureRunner({ context, executeFixture } = {}) {
  return async ({ name, signal } = {}) => {
    context.assertScenarioTime();
    if (signal?.aborted) return { status: null, signal: 'SIGTERM' };
    if (executeFixture) return executeFixture({ name, signal, context });
    return new Promise((resolveResult, rejectResult) => {
      const script = [
        `process.stdout.write(${JSON.stringify(`stress fixture ${name} completed\\n`)});`,
        `process.stderr.write(${JSON.stringify(`stress fixture ${name} diagnostic\\n`)});`,
      ].join('');
      let stdout = '';
      let stderr = '';
      const append = (current, chunk) =>
        `${current}${chunk}`.slice(0, context.limits.maxOutputBytes);
      let child;
      let record;
      try {
        ({ child, record } = spawnTrackedChild(
          context,
          process.execPath,
          ['-e', script],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
          {
            signals: [signal],
            stdout: (chunk) => {
              stdout = append(stdout, chunk.toString('utf8'));
            },
            stderr: (chunk) => {
              stderr = append(stderr, chunk.toString('utf8'));
            },
          },
        ));
      } catch (error) {
        rejectResult(error);
        return;
      }
      child.once('error', rejectResult);
      child.once('close', (status, signalName) => {
        resolveResult({
          status,
          signal: signalName,
          output: {
            stdout: {
              text: stdout,
              truncated: false,
              sourceBytes: Buffer.byteLength(stdout),
            },
            stderr: {
              text: stderr,
              truncated: false,
              sourceBytes: Buffer.byteLength(stderr),
            },
            truncated: false,
          },
          cleanup: {
            status: record.closed ? 'passed' : 'failed',
            survivingOwnedChildren: record.closed ? 0 : 1,
          },
        });
      });
    });
  };
}

async function killFixtureProcess(context) {
  context.assertScenarioTime();
  const { child, record } = spawnTrackedChild(
    context,
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true },
  );
  await boundedPromise(
    new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    }),
    fixtureTimeout(context),
    'fixture child did not spawn',
  );
  const pid = child.pid;
  const settled = await terminateTrackedChild(context, record);
  assert(settled, 'killed fixture child did not settle');
  return { pid };
}

/** Narrow test seam for proving the live finalizer kills an exact child. */
export function startTrackedFixture(
  context,
  script = 'setInterval(() => {}, 1000)',
  { spawnImpl = spawn } = {},
) {
  return spawnTrackedChild(
    context,
    process.execPath,
    ['-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    {},
    spawnImpl,
  ).record;
}

function coordinateOptions(
  fixture,
  worktree,
  identity,
  toolchain,
  context,
  {
    signal = context.controller.signal,
    timeoutMs = fixtureTimeout(context),
  } = {},
) {
  const boundedTimeout = Math.max(
    1,
    Math.min(timeoutMs, fixtureTimeout(context)),
  );
  return {
    cwd: worktree,
    root: fixture.coordinatorRoot,
    capacity: 100,
    heartbeatMs: 5,
    staleMs: 10,
    timeoutMs: boundedTimeout,
    deadlineAt: Math.min(
      context.scenarioDeadlineAt,
      context.now() + boundedTimeout,
    ),
    signal,
    wait: (ms) => waitScenario(context, ms),
    // The stress harness verifies coordinator ownership and scheduling, not the
    // machine running the fixture. Keep heavy-lane admission deterministic so
    // ambient CPU pressure cannot turn a conformance assertion into a host
    // health check.
    hostCpuSampler: async () => ({
      status: 'healthy',
      busyPercent: 0,
      cpuCount: 1,
      sampleMs: 0,
      sampledAt: context.now(),
      thresholdPercent: 85,
      source: 'fixture',
    }),
    collectProvenance: () =>
      fixtureProvenance(fixture, worktree, identity, toolchain),
    toolchain,
  };
}

/**
 * Runs scenarios against caller-provided disposable paths. Tests inject simple
 * result fixtures; the live command uses real, tracked child processes.
 */
export async function runInjectedStressConformance({
  fixture,
  executeFixture,
  context = createStressContext(),
} = {}) {
  assert(
    fixture?.worktrees?.length === context.limits.maxWorktrees,
    'worktree bound',
  );
  const [worktreeA, worktreeB] = fixture.worktrees;
  // Resolve once, then use this exact executable pair for both the staged
  // request keys and every coordinator execution below. This follows #2079's
  // coordinator-bound fixture rule rather than using a receipt-only stand-in.
  const toolchain = resolveVerificationToolchain();
  const runFixture = createFixtureRunner({ context, executeFixture });
  let releaseEquivalent;
  let releaseHeavy;
  try {
    const equivalentGate = new Promise((resolveGate) => {
      releaseEquivalent = resolveGate;
    });
    let equivalentCalls = 0;
    const equivalentRunner = async ({ signal }) => {
      equivalentCalls += 1;
      await Promise.race([
        equivalentGate,
        new Promise((resolveAbort) =>
          signal.addEventListener('abort', resolveAbort, { once: true }),
        ),
      ]);
      return runFixture({ name: 'equivalent', signal });
    };
    const equivalentA = coordinateVerification({
      ...coordinateOptions(
        fixture,
        worktreeA,
        'equivalent',
        toolchain,
        context,
      ),
      laneId: 'prepush',
      runner: equivalentRunner,
    });
    await waitScenario(context, 10);
    const equivalentB = coordinateVerification({
      ...coordinateOptions(
        fixture,
        worktreeB,
        'equivalent',
        toolchain,
        context,
      ),
      laneId: 'prepush',
      runner: equivalentRunner,
    });
    releaseEquivalent();
    const [owner, joiner] = await Promise.all([equivalentA, equivalentB]);
    assert(
      equivalentCalls === 1,
      'equivalent requests launched more than one child',
    );
    assert(
      [owner.disposition, joiner.disposition].sort().join(',') ===
        'executed,joined',
      'equivalent requests did not execute and join',
    );
    const reused = await coordinateVerification({
      ...coordinateOptions(
        fixture,
        worktreeB,
        'equivalent',
        toolchain,
        context,
      ),
      laneId: 'prepush',
      runner: equivalentRunner,
    });
    assert(
      reused.disposition === 'reused',
      'joined worktree did not reuse local receipt',
    );
    assertPrivateArtifacts(owner, worktreeA);
    assertPrivateArtifacts(joiner, worktreeB);
    for (const artifact of owner.receipt.artifacts)
      assert(
        existsSync(join(worktreeA, artifact.path)),
        'owner artifact was reclaimed',
      );

    const invalidated = await coordinateVerification({
      ...coordinateOptions(
        fixture,
        worktreeA,
        'workspace-changed',
        toolchain,
        context,
      ),
      laneId: 'prepush',
      runner: ({ signal }) => runFixture({ name: 'invalidated', signal }),
    });
    assert(
      invalidated.disposition === 'executed',
      'workspace change reused a receipt',
    );
    assertPrivateArtifacts(invalidated, worktreeA);

    const heavyGate = new Promise((resolveGate) => {
      releaseHeavy = resolveGate;
    });
    const heavy = coordinateVerification({
      ...coordinateOptions(fixture, worktreeA, 'heavy', toolchain, context),
      laneId: 'verify-static',
      runner: async ({ signal }) => {
        await Promise.race([
          heavyGate,
          new Promise((resolveAbort) =>
            signal.addEventListener('abort', resolveAbort, { once: true }),
          ),
        ]);
        return runFixture({ name: 'heavy', signal });
      },
    });
    // station#1804: this wait *is* the admission handshake, so time it. The
    // timeout scenario below needs a deadline that outlives an admission under
    // whatever contention this run is actually experiencing, and the only
    // trustworthy sample of that is the one this run just took.
    const admissionObservedFrom = context.now();
    await waitForScenario(context, () =>
      verificationStatus({ root: fixture.coordinatorRoot }).jobs.some(
        (job) => job.state === 'admitted' || job.state === 'running',
      ),
    );
    const observedAdmissionMs = context.now() - admissionObservedFrom;
    const canceledController = new AbortController();
    const abortQueued = () => canceledController.abort();
    context.controller.signal.addEventListener('abort', abortQueued, {
      once: true,
    });
    const queued = coordinateVerification({
      ...coordinateOptions(fixture, worktreeB, 'queued', toolchain, context, {
        signal: canceledController.signal,
      }),
      laneId: 'prepush',
      runner: ({ signal }) => runFixture({ name: 'queued', signal }),
    });
    await waitForScenario(
      context,
      () => verificationStatus({ root: fixture.coordinatorRoot }).waiting > 0,
    );
    canceledController.abort();
    context.controller.signal.removeEventListener('abort', abortQueued);
    releaseHeavy();
    const [heavyResult, queuedResult] = await Promise.all([heavy, queued]);
    assert(heavyResult.receipt.terminal.passed, 'heavy fixture did not pass');
    assert(
      queuedResult.receipt.terminal.status === 'canceled',
      'queued request did not record cancellation',
    );

    // Leave room for the admission handshake; this scenario measures an
    // admitted runner deadline, not pre-admission expiry. station#1804: the
    // room is derived from the admission this run just observed rather than
    // fixed at 100 ms, because concurrent vitest doubles that handshake and a
    // constant only relocates the cliff.
    const requestedBudgetMs = timeoutScenarioBudgetMs(
      observedAdmissionMs,
      context.limits,
    );
    // station#1804 review, M-3: `coordinateOptions` clamps the request to
    // `laneTimeoutMs` and to whatever is left of the scenario budget. Reporting
    // the *requested* number would name a deadline that was never in force — in
    // the one message whose whole job is naming the cause honestly. Capture
    // what the coordinator will actually enforce.
    const timeoutOptions = coordinateOptions(
      fixture,
      worktreeA,
      'timeout',
      toolchain,
      context,
      { timeoutMs: requestedBudgetMs },
    );
    const effectiveBudgetMs = timeoutOptions.timeoutMs;
    const timedOut = await coordinateVerification({
      ...timeoutOptions,
      laneId: 'test-full',
      runner: async ({ signal }) => {
        await new Promise((resolveAbort) =>
          signal.addEventListener('abort', resolveAbort, { once: true }),
        );
        return runFixture({ name: 'timeout-cleanup' });
      },
    });
    assert(
      timedOut.receipt.terminal.status === 'timed_out',
      // station#1804: name the cause. `infrastructure_error` here is the
      // signature of the deadline expiring *before* admission, which says
      // nothing about the runner-deadline contract this scenario exists to
      // prove — and reading the old message as a coordinator defect is what
      // cost an investigation during #1686.
      timedOut.receipt.terminal.status === 'infrastructure_error'
        ? `timeout expired before admission, so this scenario measured pre-admission ` +
            `expiry rather than an admitted runner deadline: the enforced deadline was ` +
            `${effectiveBudgetMs}ms (requested ${requestedBudgetMs}ms = max(floor ` +
            `${context.limits.minTimeoutHeadroomMs}ms, ${context.limits.admissionHeadroomFactor}x ` +
            `observed admission ${observedAdmissionMs}ms), then clamped by laneTimeoutMs ` +
            `${context.limits.laneTimeoutMs}ms and the remaining scenario budget). ` +
            `Suspect concurrent vitest/lease contention, not a coordinator defect`
        : `timeout did not record a timed_out receipt (status ${timedOut.receipt.terminal.status})`,
    );
    assertPrivateArtifacts(timedOut, worktreeA);

    const killed = await killFixtureProcess(context);
    const staleProvenance = fixtureProvenance(
      fixture,
      worktreeA,
      'stale-owner',
      toolchain,
    );
    const staleRequest = createVerificationRequest('prepush', staleProvenance);
    const staleOwner = {
      pid: killed.pid,
      processStart: null,
      nonce: randomUUID(),
    };
    assert(
      __verificationCoordinatorInternals.acquireLeaseDirectory(
        join(
          fixture.coordinatorRoot,
          'requests',
          executionEquivalenceKey(staleRequest),
        ),
        {
          owner: staleOwner,
          request: staleRequest,
          weight: 40,
          capacity: 100,
          state: 'running',
          heartbeatAt: 0,
        },
      ),
      'could not stage killed owner lease',
    );
    assert(
      __verificationCoordinatorInternals.acquireLeaseDirectory(
        join(fixture.coordinatorRoot, 'scheduler.lock'),
        { owner: staleOwner, state: 'scheduler', heartbeatAt: 0 },
      ),
      'could not stage killed scheduler lease',
    );
    const recovered = await coordinateVerification({
      ...coordinateOptions(
        fixture,
        worktreeA,
        'stale-owner',
        toolchain,
        context,
      ),
      laneId: 'prepush',
      runner: ({ signal }) => runFixture({ name: 'recovered', signal }),
    });
    assert(
      recovered.disposition === 'executed',
      'dead owner was not recovered',
    );
    assertPrivateArtifacts(recovered, worktreeA);
    context.assertScenarioTime();
    return {
      equivalentCalls,
      fixtureProcesses: context.tracker.count,
      checks: 7,
      limits: context.limits,
    };
  } finally {
    releaseEquivalent?.();
    releaseHeavy?.();
    context.controller.abort();
    if (!(await settleTrackedChildren(context))) context.cleanupFailed = true;
  }
}

function createTemporaryGitFixture(context) {
  context.assertScenarioTime();
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const repository = join(root, 'repository');
  const worktreeA = join(root, 'worktree-a');
  const worktreeB = join(root, 'worktree-b');
  try {
    mkdirSync(repository, { recursive: true, mode: 0o700 });
    runGit(repository, ['init', '--initial-branch=main'], context);
    runGit(
      repository,
      ['config', 'user.email', 'stress@example.invalid'],
      context,
    );
    runGit(
      repository,
      ['config', 'user.name', 'Station stress fixture'],
      context,
    );
    writeFileSync(
      join(repository, 'fixture.txt'),
      'station verification stress\n',
      {
        mode: 0o600,
      },
    );
    runGit(repository, ['add', 'fixture.txt'], context);
    runGit(repository, ['commit', '-m', 'stress fixture'], context);
    runGit(repository, ['worktree', 'add', '--detach', worktreeA], context);
    runGit(repository, ['worktree', 'add', '--detach', worktreeB], context);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: fixtureTimeout(context),
      maxBuffer: context.limits.maxOutputBytes,
      windowsHide: true,
    });
    context.assertScenarioTime();
    if (head.error || head.status !== 0)
      throw new Error('fixture head lookup failed');
    return {
      root,
      coordinatorRoot: join(root, 'coordinator'),
      repositoryId: hash(`fixture-repository:${root}`),
      headSha: head.stdout.trim(),
      worktrees: [worktreeA, worktreeB],
    };
  } catch (error) {
    safeRemoveTemporaryRoot(root);
    throw error;
  }
}

function cleanupError(root, cause) {
  const error = new Error(
    `verification stress cleanup could not settle; retained quarantine: ${root}`,
    { cause },
  );
  error.retainedRoot = root;
  return error;
}

async function finalizeLiveStress({ context, root, scenario }) {
  context.controller.abort();
  const scenarioSettled = scenario
    ? await boundedPromise(
        scenario.then(
          () => true,
          () => true,
        ),
        cleanupBudget(context),
        'scenario did not settle during cleanup reserve',
      ).catch(() => false)
    : true;
  const childrenSettled = await settleTrackedChildren(context);
  if (
    !scenarioSettled ||
    !childrenSettled ||
    context.cleanupFailed ||
    context.remainingCleanup() < 1
  )
    return { removed: false, retainedRoot: root };
  try {
    safeRemoveTemporaryRoot(root);
    return { removed: true };
  } catch {
    return { removed: false, retainedRoot: root };
  }
}

/** Live orchestration seam: tests inject failing/hanging scenarios safely. */
export async function runLiveStress({
  context = createStressContext(),
  createFixture = createTemporaryGitFixture,
  runConformance = runInjectedStressConformance,
} = {}) {
  let fixture;
  let scenario;
  let result;
  let failure;
  try {
    fixture = createFixture(context);
    scenario = Promise.resolve(runConformance({ fixture, context }));
    result = await runWithScenarioDeadline(context, scenario);
  } catch (error) {
    failure = error;
  }
  if (!fixture?.root) {
    context.controller.abort();
    await settleTrackedChildren(context);
    throw failure;
  }
  const finalization = await finalizeLiveStress({
    context,
    root: fixture.root,
    scenario,
  });
  if (!finalization.removed)
    throw cleanupError(finalization.retainedRoot, failure);
  if (failure) throw failure;
  return result;
}

export async function runVerificationStress() {
  return runLiveStress();
}

async function main() {
  try {
    const { run } = parseStressArgs(process.argv.slice(2));
    const result = run ? await runVerificationStress() : stressPlan();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exitCode = await main();
