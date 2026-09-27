import { join } from 'node:path';
import { resolveLane } from '../verification-lanes.mjs';
import {
  assertVerificationToolchain,
  collectVerificationProvenance,
  resolveVerificationToolchain,
  verificationExecutionEnvironment,
} from './test-reliability.mjs';
import { assertInstalledDependenciesMatchLockfile } from './verification-environment-preflight.mjs';
import {
  createHostCpuSampler,
  DEFAULT_HOST_PRESSURE_WAIT_MS,
  isLaneHostPressureGated,
  resolveHostPressureThreshold,
} from './verification-host-pressure.mjs';
import {
  STALE_MS,
  verificationLeaseOwnership,
} from './verification-lease-ownership.mjs';
import { createVerificationRequest } from './verification-receipt.mjs';
import { bindVerificationRequestEnvironment } from './verification-request-environment.mjs';
import {
  defaultCoordinatorRoot,
  receiptPath,
} from './verification-request-identity.mjs';

const DEFAULT_CAPACITY = 100;
const HEARTBEAT_MS = 1_000;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function assertExpectedRequest({
  lane,
  cwd,
  collectProvenance,
  expectedRequest,
  stage,
}) {
  if (!expectedRequest) return;
  const current = createVerificationRequest(
    lane.id,
    collectProvenance({ cwd }),
  );
  if (JSON.stringify(current) !== JSON.stringify(expectedRequest))
    throw new Error(`verification request changed before ${stage}`);
}

export function prepareCoordinatorContext({
  laneId,
  cwd = process.cwd(),
  force = false,
  capacity = DEFAULT_CAPACITY,
  root = defaultCoordinatorRoot(),
  heartbeatMs = HEARTBEAT_MS,
  staleMs = STALE_MS,
  collectProvenance = collectVerificationProvenance,
  runner,
  phaseRunner,
  signal,
  timeoutMs,
  deadlineAt,
  wait = sleep,
  now = Date.now,
  terminalHooks,
  hostCpuSampler,
  hostPressureThreshold,
  hostPressureWaitMs = DEFAULT_HOST_PRESSURE_WAIT_MS,
  env = process.env,
  toolchain,
  expectedRequest,
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)
    throw new Error('capacity must be an integer from 1 to 100');
  const lane = resolveLane(laneId);
  const laneTimeoutMs = timeoutMs ?? lane.timeoutMs;
  if (!Number.isInteger(laneTimeoutMs) || laneTimeoutMs < 1)
    throw new Error('timeoutMs must be a positive integer');
  const threshold = hostPressureThreshold ?? resolveHostPressureThreshold(env);
  const hostPressureGated = isLaneHostPressureGated(lane);
  const sampler = hostCpuSampler ?? createHostCpuSampler({ threshold, now });
  const absoluteDeadline = deadlineAt ?? now() + laneTimeoutMs;
  const resolvedToolchain =
    toolchain ?? resolveVerificationToolchain({ cwd, env });
  const executionEnv = verificationExecutionEnvironment(resolvedToolchain, env);
  const collectBoundProvenance = ({
    cwd: provenanceCwd = cwd,
    ...rest
  } = {}) => {
    assertVerificationToolchain(resolvedToolchain);
    return {
      ...collectProvenance({ ...rest, cwd: provenanceCwd }),
      toolchain: resolvedToolchain.toolchain,
      toolchainIdentity: resolvedToolchain.identity,
    };
  };
  const before = collectBoundProvenance({ cwd });
  // station#4109: refuse before any phase admission when node_modules does
  // not match the locked dependencies -- otherwise a stale install produces
  // phase failures that read exactly like branch defects. This must run
  // before `request`/admission are ever derived: a thrown
  // VerificationEnvironmentStaleError here never reaches a lease, a phase,
  // or a receipt.
  assertInstalledDependenciesMatchLockfile({ repositoryRoot: before.worktree });
  const request = createVerificationRequest(lane.id, before);
  const requestEnv = bindVerificationRequestEnvironment(executionEnv, request);
  assertExpectedRequest({
    lane,
    cwd,
    collectProvenance: collectBoundProvenance,
    expectedRequest,
    stage: 'coordinator admission',
  });
  const actualRoot = root;
  verificationLeaseOwnership.ensureDirectory(join(actualRoot, 'requests'));
  verificationLeaseOwnership.ensureDirectory(join(actualRoot, 'outputs'));
  verificationLeaseOwnership.gcFinishedLeases(actualRoot, { now: now() });
  return {
    laneId,
    cwd,
    force,
    capacity,
    root: actualRoot,
    heartbeatMs,
    staleMs,
    collectProvenance: collectBoundProvenance,
    toolchain: resolvedToolchain,
    runner,
    phaseRunner,
    signal,
    timeoutMs: laneTimeoutMs,
    absoluteDeadline,
    wait,
    now,
    terminalHooks,
    lane,
    before,
    request,
    canonicalPath: receiptPath(before.worktree, request.key, false),
    hostCpuSampler: sampler,
    hostPressureThreshold: threshold,
    hostPressureWaitMs,
    hostPressureGated,
    env: requestEnv,
    expectedRequest,
  };
}
