import { join } from 'node:path';
import {
  DEFAULT_HOST_PRESSURE_WAIT_MS,
  pressureGateSatisfied,
} from './verification-host-pressure.mjs';

function tryAdmitQueuedLane({
  root,
  directoryKey,
  owner,
  lane,
  capacity,
  schedulerLock,
  staleMs,
  now,
  hostPressureGated,
  consecutiveHealthy,
  lastSample,
  currentLease,
  updateLease,
  seams,
}) {
  let schedulerOwned = seams.acquireLeaseDirectory(schedulerLock, {
    owner,
    heartbeatAt: now(),
    state: 'scheduler',
  });
  if (
    !schedulerOwned &&
    seams.cleanStaleDirectory(schedulerLock, { now: now(), staleMs })
  )
    schedulerOwned = seams.acquireLeaseDirectory(schedulerLock, {
      owner,
      heartbeatAt: now(),
      state: 'scheduler',
    });
  if (!schedulerOwned) return false;
  try {
    const capacityOk =
      seams.activeWeight(root, directoryKey, { now: now(), staleMs }) +
        lane.weight <=
      capacity;
    const sampleOk =
      !hostPressureGated ||
      pressureGateSatisfied(consecutiveHealthy, lastSample, now);
    const fifoBlocker =
      hostPressureGated && sampleOk
        ? seams.hostPressureFifoBlocker(root, directoryKey, currentLease(), {
            now: now(),
            staleMs,
          })
        : null;
    const fairnessBlocker = seams.fullWeightQueueBlocker(
      root,
      directoryKey,
      lane,
      capacity,
      { now: now(), staleMs },
    );
    if (!capacityOk || !sampleOk || fifoBlocker || fairnessBlocker)
      return false;
    return updateLease({
      ...currentLease(),
      state: 'admitted',
      heartbeatAt: now(),
      hostPressure: lastSample,
      queueReason: undefined,
      blockingRequestKey: undefined,
      pressureWaitStartedAt: undefined,
    });
  } finally {
    seams.removeOwnedDirectory(schedulerLock, owner);
  }
}

export async function acquireAdmittedOutput({
  outputLock,
  currentLease,
  now,
  staleMs,
  signal,
  deadline,
  wait,
  heartbeatMs,
  ownOutput,
}) {
  while (true) {
    if (signal?.aborted)
      return { outputOwned: false, canceled: true, deadlineExpired: false };
    const outputOwned = ownOutput(
      outputLock,
      { ...currentLease(), state: 'output', heartbeatAt: now() },
      { now: now(), staleMs },
    );
    if (outputOwned)
      return { outputOwned: true, canceled: false, deadlineExpired: false };
    if (now() >= deadline)
      return { outputOwned: false, canceled: true, deadlineExpired: true };
    await wait(Math.min(heartbeatMs, Math.max(1, deadline - now())));
  }
}

function tryOwnOutputFence({
  outputLock,
  currentLease,
  now,
  staleMs,
  ownOutput,
}) {
  return ownOutput(
    outputLock,
    { ...currentLease(), state: 'output', heartbeatAt: now() },
    { now: now(), staleMs },
  );
}

function queueCapacityWait({
  root,
  directoryKey,
  lane,
  capacity,
  staleMs,
  hostPressureGated,
  consecutiveHealthy,
  lastSample,
  currentLease,
  updateLease,
  now,
  recordQueuedPressure,
  seams,
}) {
  if (hostPressureGated && consecutiveHealthy < 2) {
    recordQueuedPressure(lastSample);
    return;
  }
  const fairnessBlocker = seams.fullWeightQueueBlocker(
    root,
    directoryKey,
    lane,
    capacity,
    { now: now(), staleMs },
  );
  const fifoBlocker = hostPressureGated
    ? seams.hostPressureFifoBlocker(root, directoryKey, currentLease(), {
        now: now(),
        staleMs,
      })
    : null;
  const blocker = fairnessBlocker ?? fifoBlocker;
  updateLease({
    ...currentLease(),
    state: 'queued',
    heartbeatAt: now(),
    queueReason: fairnessBlocker
      ? 'full_weight_fairness'
      : fifoBlocker
        ? 'host_pressure_fifo'
        : undefined,
    blockingRequestKey: blocker?.key,
    pressureWaitStartedAt: undefined,
    ...(hostPressureGated && lastSample ? { hostPressure: lastSample } : {}),
  });
}

/** Admission and output ownership are separate fences: capacity never grants
 * permission to mutate a sibling worktree's retained output path.
 *
 * Host-pressure gating (heavy lanes, weight >= HOST_PRESSURE_GATE_WEIGHT) is
 * performed before admission: the lane samples host CPU pressure outside the
 * scheduler lock until it has two consecutive healthy samples, then under the
 * lock it requires the latest healthy sample to be fresh, itself to be the
 * FIFO-earliest queued gated lane, and host capacity to be available before
 * admitting atomically. While pressured or unavailable the lane stays queued
 * with `queueReason: 'host_pressure'` and holds no scheduler/output lock; once
 * admitted it is never resampled, requeued, or canceled due to pressure. A
 * pressure-wait bound (default 5m, capped by the request deadline) publishes a
 * `host_pressure_timeout` outcome without invoking the runner, and an
 * unavailable sampler fails closed. */
function createPressureGateState({ hostPressureGated, now }) {
  return {
    consecutiveHealthy: 0,
    lastSample: null,
    pressureBoundActive: hostPressureGated,
    pressureWaitStartedAt: hostPressureGated ? now() : null,
  };
}

async function advancePressureGate({
  hostPressureGated,
  state,
  hostCpuSampler,
  signal,
  deadline,
  hostPressureWaitMs,
  now,
  wait,
  heartbeatMs,
  recordQueuedPressure,
}) {
  if (
    !hostPressureGated ||
    pressureGateSatisfied(state.consecutiveHealthy, state.lastSample, now)
  )
    return { ready: true };
  if (state.consecutiveHealthy >= 2 && state.lastSample?.status === 'healthy')
    state.consecutiveHealthy = 0;
  let sample;
  try {
    sample = await hostCpuSampler();
  } catch {
    sample = { status: 'unavailable' };
  }
  state.lastSample = sample;
  if (signal?.aborted) return { canceled: true };
  if (sample.status === 'healthy') {
    state.consecutiveHealthy += 1;
    if (state.consecutiveHealthy >= 2) state.pressureBoundActive = false;
  } else {
    state.consecutiveHealthy = 0;
    recordQueuedPressure(sample);
  }
  const pressureDeadline = Math.min(
    state.pressureWaitStartedAt + hostPressureWaitMs,
    deadline,
  );
  if (
    state.pressureBoundActive &&
    state.consecutiveHealthy < 2 &&
    now() >= pressureDeadline
  )
    return { hostPressureOutcome: 'timeout' };
  if (now() >= deadline) return { deadlineExpired: true };
  await wait(
    Math.min(
      heartbeatMs,
      Math.max(
        1,
        (state.pressureBoundActive ? pressureDeadline : deadline) - now(),
      ),
    ),
  );
  return { ready: false };
}

function attemptAdmissionIteration({
  outputOwned,
  deferOutputOwnership,
  outputLock,
  currentLease,
  now,
  staleMs,
  root,
  directoryKey,
  owner,
  lane,
  capacity,
  schedulerLock,
  hostPressureGated,
  state,
  updateLease,
  seams,
}) {
  const owned =
    outputOwned ||
    (!deferOutputOwnership &&
      tryOwnOutputFence({
        outputLock,
        currentLease,
        now,
        staleMs,
        ownOutput: seams.ownOutput,
      }));
  if (!owned && !deferOutputOwnership)
    return { outputOwned: false, admitted: false };
  return {
    outputOwned: owned,
    admitted: tryAdmitQueuedLane({
      root,
      directoryKey,
      owner,
      lane,
      capacity,
      schedulerLock,
      staleMs,
      now,
      hostPressureGated,
      consecutiveHealthy: state.consecutiveHealthy,
      lastSample: state.lastSample,
      currentLease,
      updateLease,
      seams,
    }),
  };
}

function admissionOutcome({
  canceled = false,
  deadlineExpired = false,
  outputOwned = false,
  admitted = false,
  hostPressureOutcome = null,
}) {
  return {
    canceled,
    deadlineExpired,
    outputOwned,
    admitted,
    hostPressureOutcome,
  };
}

function pressureAdmissionOutcome(step, outputOwned) {
  if (step.canceled) return admissionOutcome({ canceled: true, outputOwned });
  if (step.deadlineExpired)
    return admissionOutcome({
      deadlineExpired: true,
      outputOwned,
    });
  if (step.hostPressureOutcome)
    return admissionOutcome({
      outputOwned,
      hostPressureOutcome: step.hostPressureOutcome,
    });
  return null;
}

async function waitForAdmissionRetry({
  root,
  directoryKey,
  lane,
  capacity,
  staleMs,
  hostPressureGated,
  pressure,
  currentLease,
  updateLease,
  now,
  recordQueuedPressure,
  deadline,
  wait,
  heartbeatMs,
  seams,
}) {
  queueCapacityWait({
    root,
    directoryKey,
    lane,
    capacity,
    staleMs,
    hostPressureGated,
    consecutiveHealthy: pressure.consecutiveHealthy,
    lastSample: pressure.lastSample,
    currentLease,
    updateLease,
    now,
    recordQueuedPressure,
    seams,
  });
  if (now() >= deadline) return true;
  await wait(Math.min(heartbeatMs, Math.max(1, deadline - now())));
  return false;
}

async function runAdmissionLoop(options) {
  const { pressure, outputOwned: initialOutputOwned, ...context } = options;
  let outputOwned = initialOutputOwned;
  while (true) {
    if (context.signal?.aborted)
      return admissionOutcome({ canceled: true, outputOwned });
    const pressureStep = await advancePressureGate({
      ...context,
      state: pressure,
    });
    const pressureOutcome = pressureAdmissionOutcome(pressureStep, outputOwned);
    if (pressureOutcome) return pressureOutcome;
    if (!pressureStep.ready) continue;
    const step = attemptAdmissionIteration({
      ...context,
      outputOwned,
      state: pressure,
    });
    outputOwned = step.outputOwned;
    if (step.admitted) return admissionOutcome({ admitted: true, outputOwned });
    const deadlineExpired = await waitForAdmissionRetry({
      ...context,
      pressure,
    });
    if (deadlineExpired)
      return admissionOutcome({
        canceled: true,
        deadlineExpired: true,
        outputOwned,
      });
  }
}

export async function admitAndOwnOutput({
  root,
  directoryKey,
  owner,
  lane,
  capacity,
  outputLock,
  staleMs,
  signal,
  deadline,
  heartbeatMs,
  wait,
  now,
  currentLease,
  updateLease,
  hostPressureGated = false,
  hostCpuSampler = null,
  hostPressureWaitMs = DEFAULT_HOST_PRESSURE_WAIT_MS,
  outputAlreadyOwned = false,
  deferOutputOwnership = false,
  seams,
}) {
  const schedulerLock = join(root, 'scheduler.lock');
  const pressure = createPressureGateState({ hostPressureGated, now });

  const recordQueuedPressure = (sample) => {
    updateLease({
      ...currentLease(),
      state: 'queued',
      queueReason: 'host_pressure',
      blockingRequestKey: undefined,
      pressureWaitStartedAt: pressure.pressureWaitStartedAt,
      hostPressure: sample,
      heartbeatAt: now(),
    });
  };

  return runAdmissionLoop({
    root,
    directoryKey,
    owner,
    lane,
    capacity,
    outputLock,
    staleMs,
    signal,
    deadline,
    heartbeatMs,
    wait,
    now,
    currentLease,
    updateLease,
    hostPressureGated,
    hostCpuSampler,
    hostPressureWaitMs,
    deferOutputOwnership,
    schedulerLock,
    pressure,
    recordQueuedPressure,
    outputOwned: outputAlreadyOwned,
    seams,
  });
}
