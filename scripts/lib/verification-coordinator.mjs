import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import receiptSchema from '../../schemas/verification-receipt.schema.json' with {
  type: 'json',
};
import {
  CANONICAL_COMPLETION_LANE,
  resolveLane,
} from '../verification-lanes.mjs';
import {
  latestE2EEvidenceBinding,
  projectLatestE2EEvidence,
  validateLatestE2EEvidence,
} from './e2e-latest-evidence.mjs';
import {
  collectVerificationProvenance,
  preflightReceiptDestination,
  writeReceiptSecurely,
} from './test-reliability.mjs';
import {
  acquireAdmittedOutput as acquireAdmittedOutputWithSeam,
  admitAndOwnOutput as admitAndOwnOutputWithSeams,
} from './verification-admission.mjs';
import {
  releaseVerificationArtifactMutation,
  tryAcquireVerificationArtifactMutation,
} from './verification-artifact-mutation.mjs';
import { attachCiFastDiagnostics } from './verification-ci-fast-diagnostics.mjs';
import {
  createCompletionPhaseRunner,
  phaseRecordPassed,
} from './verification-completion-phases.mjs';
import {
  createOwnedRunner,
  runWithinDeadline,
} from './verification-execution-lifecycle.mjs';
import {
  CAPACITY_CONSUMING_STATES,
  FULL_WEIGHT_CI_FAST_BYPASS_MS,
  leaseIsLive,
  STALE_MS,
  verificationLeaseOwnership,
} from './verification-lease-ownership.mjs';
import {
  assertReceiptSemantics,
  createVerificationReceipt,
  createVerificationRequest,
} from './verification-receipt.mjs';
import {
  projectVerificationArtifacts,
  readVerifiedVerificationArtifact,
  verifyVerificationArtifacts,
} from './verification-reporter.mjs';
import {
  assertExpectedRequest,
  prepareCoordinatorContext,
} from './verification-request-context.mjs';
import {
  completionLockDirectory,
  completionQueueLockDirectory,
  defaultCoordinatorRoot,
  executionEquivalenceKey,
  verificationIdentityDigest as hash,
  jobDirectory,
  outputDirectory,
  receiptPath,
  receiptRelativePath,
  requestDirectoryKey,
  VERIFICATION_RECEIPT_ROOT,
} from './verification-request-identity.mjs';
import { verificationRetentionInventory } from './verification-retention-inventory.mjs';
import {
  publishTerminalReceipt,
  reportExecution,
} from './verification-terminal-receipt.mjs';

const DEFAULT_CAPACITY = 100;
// A job in any of these admission states consumes host weight capacity, so the
// status `usedWeight` projection must count exactly the same states that the
// admission `activeWeight` check excludes a new lane from.
const COMPLETION_QUEUE_REASON = 'completion_single_flight';
// A completion waiter is a live, distinct full-regression request that has
// passed request-key joining but cannot yet own the host-wide phase lock. Four
// preserves a small amount of FIFO burst tolerance while preventing detached
// submit workers from accumulating without bound behind a stalled owner.
export const MAX_COMPLETION_WAITERS = 4;
export {
  defaultCoordinatorRoot,
  executionEquivalenceKey,
  FULL_WEIGHT_CI_FAST_BYPASS_MS,
  leaseIsLive,
};

const {
  acquireLeaseDirectory,
  acquireMutationClaim,
  activeWeight,
  assertLeaseOwner,
  cleanStaleCompletionJobs,
  cleanStaleDirectory,
  completionQueueEligible,
  completionWaiterCount,
  createOwnedDirectoryRemover,
  createOwner,
  ensureDirectory,
  fullWeightQueueBlocker,
  gcFinishedLeases,
  hostPressureFifoBlocker,
  isSettledLease,
  listJobs,
  markOwnershipLostBestEffort,
  ownOutput,
  processIdentity,
  readJson,
  recoverExactChild,
  recoverMutationClaim,
  releaseMutationClaim,
  removeOwnedDirectory,
  removeOwnedDirectoryOutcome,
  statusForDirectory,
  withOwnedLeaseMutation,
  writeOwnedLease,
  writeTransactionLease,
} = verificationLeaseOwnership;
const receiptValidator = new Ajv2020({ strict: true }).compile(receiptSchema);

function reusableOutputBindingsFromRaw(raw, lane) {
  if (!(lane.reusableOutputs?.length > 0)) return undefined;
  if (Array.isArray(raw?.reusableOutputs)) return raw.reusableOutputs;
  const matches = [
    ...(raw?.output?.stdout?.text ?? '').matchAll(
      /^\[e2e-binding\] ([A-Za-z0-9_-]+)$/gm,
    ),
  ];
  if (matches.length !== 1) return undefined;
  try {
    const binding = JSON.parse(
      Buffer.from(matches[0][1], 'base64url').toString('utf8'),
    );
    return [binding];
  } catch {
    return undefined;
  }
}

function privateCommand(lane, toolchain) {
  // Public lanes use distinct raw scripts to prevent the wrapper from
  // recursively coordinating. The canonical completion lane is phase-run.
  const scripts = {
    'ci-fast': 'ci:fast:raw',
    'full-regression': 'full:regression:raw',
    prepush: 'test:prepush:raw',
    'test-full': 'test:full:raw',
    'test-coverage': 'test:coverage:raw',
    'verify-static': 'verify:static:raw',
    'verify-local': 'verify:local:raw',
    'verify-e2e-full': 'verify:e2e:full:raw',
  };
  const script = lane.privateScript ?? scripts[lane.id];
  if (!script)
    throw new Error(`lane '${lane.id}' has no safe private command adapter`);
  if (!toolchain?.nodeExecutable || !toolchain?.npmExecutable)
    throw new Error(
      'verification toolchain setup error: missing bound Node/npm executables',
    );
  return [toolchain.nodeExecutable, [toolchain.npmExecutable, 'run', script]];
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function receiptContents(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function receiptCommitPath(path) {
  return `${path}.commit.json`;
}

function pendingReceiptPath(worktree, requestKey, owner, generation) {
  return join(
    worktree,
    VERIFICATION_RECEIPT_ROOT,
    `${requestKey}.pending-${owner.nonce}-${generation}.json`,
  );
}

function writeReceiptAt({ worktree, path, contents }) {
  const relativePath = receiptRelativePath(worktree, path);
  preflightReceiptDestination(relativePath, worktree);
  writeReceiptSecurely(relativePath, contents, worktree);
}

function commitCanonicalReceipt({ worktree, path, receipt, contents }) {
  writeReceiptAt({
    worktree,
    path: receiptCommitPath(path),
    contents: `${JSON.stringify(
      {
        requestKey: receipt.request.key,
        receiptDigest: hash(contents),
        committed: true,
      },
      null,
      2,
    )}\n`,
  });
}

function receiptIsCommitted(path, requestKey) {
  const contents = (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  })();
  const commit = readJson(receiptCommitPath(path));
  return (
    contents !== null &&
    commit?.committed === true &&
    commit.requestKey === requestKey &&
    commit.receiptDigest === hash(contents)
  );
}

function quarantineExactReceipt({ path, contents, suffix, beforeQuarantine }) {
  try {
    beforeQuarantine?.();
    if (readFileSync(path, 'utf8') !== contents) return false;
    renameSync(path, `${path}.${suffix}-${randomUUID()}`);
    return true;
  } catch {
    return false;
  }
}

function completedReceipt(
  path,
  requestKey,
  worktree,
  { validateReusableOutputs = true } = {},
) {
  if (!receiptIsCommitted(path, requestKey)) return null;
  const receipt = readReceipt(path);
  if (receipt?.request?.key !== requestKey) return null;
  try {
    if (!receiptValidator(receipt)) return null;
    assertReceiptSemantics(receipt);
    verifyVerificationArtifacts({
      root: worktree,
      artifacts: receipt.artifacts,
    });
    if (validateReusableOutputs)
      validateLocalReusableOutputs(
        worktree,
        receipt.request.laneId,
        receipt.request.headSha,
        receipt,
      );
    if (!completionPhaseRecordsAreExact(receipt, worktree)) return null;
    return receipt;
  } catch {
    return null;
  }
}

function completionPhaseRecordsAreExact(receipt, worktree) {
  if (receipt?.request?.laneId !== CANONICAL_COMPLETION_LANE) return true;
  const phases = resolveLane(CANONICAL_COMPLETION_LANE).phases ?? [];
  const records = [];
  try {
    for (const artifact of receipt.artifacts) {
      const contents = readVerifiedVerificationArtifact({
        root: worktree,
        artifact,
      });
      let record;
      try {
        record = JSON.parse(contents.toString('utf8'));
      } catch {
        continue;
      }
      if (record?.kind === 'completion-phase-receipt') records.push(record);
    }
  } catch {
    return false;
  }
  if (records.length !== phases.length) return false;
  const expectedRequest = JSON.stringify(receipt.request);
  const permitsProjectedSource =
    receipt.disposition === 'joined' || receipt.disposition === 'reused';
  return phases.every((phase) => {
    const matching = records.filter((record) => record?.phase?.id === phase.id);
    const sourceRequest = matching[0]?.parentRequest;
    const sourceIsExact = JSON.stringify(sourceRequest) === expectedRequest;
    // A joined/reused receipt is intentionally worktree-specific while its
    // phase evidence is projected byte-for-byte from the source worktree.
    // The source request remains authoritative for its own before/after keys;
    // the target may accept it only when all execution-relevant identity fields
    // are equivalent. Mutable outputs are still copied into the target above.
    const sourceIsEquivalent =
      permitsProjectedSource &&
      sourceRequest?.key === matching[0]?.parentRequestKey &&
      executionEquivalenceKey(sourceRequest) ===
        executionEquivalenceKey(receipt.request);
    return (
      matching.length === 1 &&
      (sourceIsExact || sourceIsEquivalent) &&
      matching[0].parentRequestKey === sourceRequest?.key &&
      matching[0].phase.command === phase.command &&
      matching[0].phase.weight === phase.weight &&
      matching[0].phase.timeoutMs === phase.timeoutMs &&
      matching[0].beforeRequestKey === sourceRequest?.key &&
      matching[0].afterRequestKey === sourceRequest?.key &&
      phaseRecordPassed(matching[0])
    );
  });
}

function publishCanonicalReceipt({ worktree, path, receipt }) {
  const contents = receiptContents(receipt);
  writeReceiptAt({ worktree, path, contents });
  commitCanonicalReceipt({ worktree, path, receipt, contents });
}

function projectOwnerReceipt(
  ownerReceipt,
  request,
  before,
  after,
  disposition,
) {
  const reusableOutputs = projectLaneReusableOutputs(
    ownerReceipt.request.worktree,
    before.worktree,
    request.laneId,
    ownerReceipt,
  );
  const artifacts = projectVerificationArtifacts({
    sourceRoot: ownerReceipt.request.worktree,
    targetRoot: before.worktree,
    requestKey: request.key,
    artifacts: ownerReceipt.artifacts,
  });
  return createVerificationReceipt({
    request,
    disposition,
    status: ownerReceipt.terminal.status,
    exitCode: ownerReceipt.terminal.exitCode,
    counts: ownerReceipt.counts,
    artifacts,
    cleanup: ownerReceipt.cleanup,
    before,
    after,
    reusableOutputs,
  });
}

function reusableOutputBinding(receipt, output) {
  const binding = receipt?.reusableOutputs?.find(
    (entry) => entry?.path === output,
  );
  if (!binding) throw new Error('receipt is missing a reusable output binding');
  return binding;
}

function sameReusableOutputBinding(left, right) {
  return (
    left?.path === right?.path &&
    left?.runId === right?.runId &&
    left?.manifestDigest === right?.manifestDigest &&
    left?.payloadDigest === right?.payloadDigest
  );
}

function validateLocalReusableOutputs(root, laneId, revision, receipt) {
  for (const output of resolveLane(laneId).reusableOutputs ?? []) {
    if (output !== '.kontourai/e2e-latest/')
      throw new Error(`unsupported reusable lane output: ${output}`);
    const latest = join(root, output);
    const manifest = validateLatestE2EEvidence(latest, {
      revision,
    });
    if (
      !sameReusableOutputBinding(
        latestE2EEvidenceBinding(latest),
        reusableOutputBinding(receipt, output),
      )
    )
      throw new Error('reusable E2E evidence no longer matches its receipt');
    if (
      manifest.verdict !== 'PASS' ||
      manifest.buckets.some((bucket) => bucket?.verdict !== 'PASS')
    )
      throw new Error('reusable E2E evidence is not a passing full-run result');
  }
}

/**
 * E2E latest is a pointer over immutable run payloads. Rebuild that pointer
 * instead of copying a mutable directory over the target so stale target
 * evidence is replaced without a missing-directory crash window.
 */
function projectLaneReusableOutputs(
  sourceRoot,
  targetRoot,
  laneId,
  ownerReceipt,
  { afterProjection = null } = {},
) {
  const outputs = resolveLane(laneId).reusableOutputs ?? [];
  const projectedBindings = [];
  for (const output of outputs) {
    if (output !== '.kontourai/e2e-latest/')
      throw new Error(`unsupported reusable lane output: ${output}`);
    const source = join(sourceRoot, output);
    const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
    if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink())
      throw new Error('reusable lane output is unavailable or unsafe');
    const manifest = validateLatestE2EEvidence(source, {
      revision: ownerReceipt.request.headSha,
    });
    const ownerBinding = reusableOutputBinding(ownerReceipt, output);
    if (
      !sameReusableOutputBinding(latestE2EEvidenceBinding(source), ownerBinding)
    )
      throw new Error('owner E2E evidence no longer matches its receipt');
    if (
      manifest.verdict !== 'PASS' ||
      manifest.buckets.some((bucket) => bucket?.verdict !== 'PASS')
    )
      throw new Error('owner E2E evidence is not a passing full-run result');
    const projected = projectLatestE2EEvidence({
      sourceDir: join(source, manifest.payloadDirectory),
      destinationDir: join(targetRoot, output),
      workspaceRoot: targetRoot,
      runId: manifest.runId,
      source: `receipt-reuse:${ownerReceipt.request.key}`,
      revision: ownerReceipt.request.headSha,
      ciRunId: manifest.ciRunId,
      buckets: manifest.buckets,
      remoteArtifact: manifest.remoteArtifact,
      reusedFrom: {
        requestKey: ownerReceipt.request.key,
        ...ownerBinding,
      },
    });
    afterProjection?.({ output, manifest, targetRoot });
    const targetBinding = latestE2EEvidenceBinding(join(targetRoot, output));
    if (
      !sameReusableOutputBinding(targetBinding, projected.projectionBinding) ||
      targetBinding.runId !== ownerBinding.runId ||
      targetBinding.payloadDigest !== ownerBinding.payloadDigest
    )
      throw new Error(
        'materialized E2E evidence does not match the owner payload binding',
      );
    validateLatestE2EEvidence(join(targetRoot, output), {
      revision: ownerReceipt.request.headSha,
      receiptRequestKey: ownerReceipt.request.key,
      ownerBinding,
    });
    projectedBindings.push(projected.projectionBinding);
  }
  return projectedBindings;
}

function validFinishedOwnerReceipt(lease, request) {
  const ownerReceipt = lease?.receiptPath
    ? completedReceipt(
        lease.receiptPath,
        lease.request?.key,
        lease.request?.worktree,
      )
    : null;
  try {
    if (!receiptValidator(ownerReceipt)) return null;
    assertReceiptSemantics(ownerReceipt);
    if (
      ownerReceipt.terminal.passed !== true ||
      ownerReceipt.provenance?.stable !== true ||
      ownerReceipt.cleanup?.survivingOwnedChildren !== 0 ||
      !['passed', 'not_required'].includes(ownerReceipt.cleanup?.status) ||
      lease.executionKey !== executionEquivalenceKey(request) ||
      executionEquivalenceKey(ownerReceipt.request) !==
        executionEquivalenceKey(request)
    )
      return null;
    verifyVerificationArtifacts({
      root: ownerReceipt.request.worktree,
      artifacts: ownerReceipt.artifacts,
    });
    return ownerReceipt;
  } catch {
    return null;
  }
}

/**
 * A finished host lease is reusable only after every owner artifact has been
 * verified and the receiving worktree remains byte-identical before and after
 * projection.  Projection copies bytes under B's request key; it never owns
 * or removes A's output directory.
 */
function reuseFinishedOwnerReceipt({
  lease,
  request,
  before,
  cwd,
  collectProvenance,
}) {
  const ownerReceipt = validFinishedOwnerReceipt(lease, request);
  if (!ownerReceipt) return null;
  const beforeProjection = collectProvenance({ cwd });
  if (
    createVerificationRequest(request.laneId, beforeProjection).key !==
    request.key
  )
    return null;
  let receipt;
  try {
    const artifacts = projectVerificationArtifacts({
      sourceRoot: ownerReceipt.request.worktree,
      targetRoot: before.worktree,
      requestKey: request.key,
      artifacts: ownerReceipt.artifacts,
    });
    const reusableOutputs = projectLaneReusableOutputs(
      ownerReceipt.request.worktree,
      before.worktree,
      request.laneId,
      ownerReceipt,
    );
    const after = collectProvenance({ cwd });
    if (createVerificationRequest(request.laneId, after).key !== request.key)
      return null;
    receipt = createVerificationReceipt({
      request,
      disposition: 'reused',
      status: ownerReceipt.terminal.status,
      exitCode: ownerReceipt.terminal.exitCode,
      counts: ownerReceipt.counts,
      artifacts,
      cleanup: ownerReceipt.cleanup,
      before,
      after,
      reusableOutputs,
    });
  } catch {
    return null;
  }
  return receipt.terminal.passed ? receipt : null;
}

function normalizedResult(
  result,
  { canceled = false, timedOut = false, rejected = false } = {},
) {
  if (rejected)
    return {
      status: 'rejected',
      exitCode: null,
      counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 },
    };
  if (timedOut)
    return {
      status: 'timed_out',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    };
  if (result?.status === 0)
    return {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    };
  if (result?.infrastructureError === true)
    return {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    };
  if (result?.signal && canceled)
    return {
      status: 'canceled',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    };
  if (result?.status == null || result?.error || result?.signal)
    return {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    };
  return {
    status: 'failed',
    exitCode: result.status,
    counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
  };
}

function admissionSeams() {
  return {
    acquireLeaseDirectory,
    activeWeight,
    cleanStaleDirectory,
    fullWeightQueueBlocker,
    hostPressureFifoBlocker,
    ownOutput,
    removeOwnedDirectory,
  };
}

function admitAndOwnOutput(options) {
  return admitAndOwnOutputWithSeams({ ...options, seams: admissionSeams() });
}

function acquireAdmittedOutput(options) {
  return acquireAdmittedOutputWithSeam({ ...options, ownOutput });
}

function localReuseResult(
  { force, canonicalPath, request, before },
  { allowQuarantine = true } = {},
) {
  const existing = !force
    ? completedReceipt(canonicalPath, request.key, before.worktree, {
        validateReusableOutputs: false,
      })
    : null;
  if (existing?.terminal?.passed === true) {
    try {
      validateLocalReusableOutputs(
        before.worktree,
        request.laneId,
        request.headSha,
        existing,
      );
    } catch {
      if (!allowQuarantine) return { needsArtifactMutation: true };
      if (!quarantineInvalidReusableReceipt(canonicalPath, request.key))
        throw new Error('unable to quarantine stale reusable receipt');
      return null;
    }
  }
  const reusable = existing?.terminal?.passed === true ? existing : null;
  return reusable
    ? {
        receipt: { ...reusable, disposition: 'reused' },
        disposition: 'reused',
        request,
        queue: [],
      }
    : null;
}

function quarantineInvalidReusableReceipt(path, requestKey) {
  const receipt = readReceipt(path);
  if (receipt?.request?.key !== requestKey) return !existsSync(path);
  const suffix = `invalid-reusable-output-${randomUUID()}`;
  try {
    const contents = receiptContents(receipt);
    writeReceiptAt({
      worktree: receipt.request.worktree,
      path: `${path}.${suffix}`,
      contents,
    });
    // Keep the canonical pathname occupied, but deliberately break its commit
    // digest/schema so the normal terminal publisher can recognize and
    // quarantine it. A missing canonical path can strand a finished output
    // lease; a tombstone follows the coordinator's existing tampered-receipt
    // recovery path instead.
    writeReceiptAt({
      worktree: receipt.request.worktree,
      path,
      contents: receiptContents({
        ...receipt,
        invalidReusableOutput: { detected: true },
      }),
    });
    return !receiptIsCommitted(path, requestKey);
  } catch {
    return false;
  }
}

function retryVerification(context) {
  return coordinateVerification({
    laneId: context.laneId,
    cwd: context.cwd,
    force: context.force,
    capacity: context.capacity,
    root: context.root,
    heartbeatMs: context.heartbeatMs,
    staleMs: context.staleMs,
    collectProvenance: context.collectProvenance,
    runner: context.runner,
    phaseRunner: context.phaseRunner,
    signal: context.signal,
    timeoutMs: Math.max(1, context.absoluteDeadline - context.now()),
    deadlineAt: context.absoluteDeadline,
    wait: context.wait,
    now: context.now,
    terminalHooks: context.terminalHooks,
    hostCpuSampler: context.hostCpuSampler,
    hostPressureThreshold: context.hostPressureThreshold,
    hostPressureWaitMs: context.hostPressureWaitMs,
    env: context.env,
    toolchain: context.toolchain,
    expectedRequest: context.expectedRequest,
  });
}

async function withArtifactMutation(context, callback) {
  const acquire = () =>
    tryAcquireVerificationArtifactMutation({
      root: context.root,
      requestKey: context.request.key,
      now: context.now(),
    });
  // Attempt before the wait guards, not after. Both guards describe *waiting*,
  // and an uncontended fence involves none: a caller that arrives with its
  // deadline already spent must still take the fence so the lease machinery
  // inside can publish its own `timed_out`/`canceled` terminal receipt. The
  // pre-attempt check rejected that caller with a bare error instead, so a
  // lane whose deadline expired before execution produced no receipt at all
  // (station#1674).
  let mutation = acquire();
  while (!mutation) {
    if (context.signal?.aborted)
      throw new Error(
        'verification canceled while waiting for artifact mutation',
      );
    if (context.now() >= context.absoluteDeadline)
      throw new Error('verification timed out waiting for artifact mutation');
    await context.wait(Math.min(context.heartbeatMs, 100));
    await new Promise((resolveYield) => setTimeout(resolveYield, 0));
    mutation = acquire();
  }
  try {
    return await callback();
  } finally {
    releaseVerificationArtifactMutation(mutation);
  }
}

async function reuseFinishedHostLease({ context, lease }) {
  const reused = reuseFinishedOwnerReceipt({
    lease,
    request: context.request,
    before: context.before,
    cwd: context.cwd,
    collectProvenance: context.collectProvenance,
  });
  if (!reused) return null;
  return withArtifactMutation(context, async () => {
    publishCanonicalReceipt({
      worktree: context.before.worktree,
      path: context.canonicalPath,
      receipt: reused,
    });
    return {
      receipt: reused,
      disposition: 'reused',
      request: context.request,
      queue: [],
    };
  });
}

function completionLeaseProjection(context, lease) {
  return {
    owner: lease.owner,
    requestKey: context.request.key,
    executionKey: executionEquivalenceKey(context.request),
    worktree: context.before.worktree,
    createdAt: lease.createdAt,
    deadlineAt: context.absoluteDeadline,
    heartbeatAt: lease.heartbeatAt,
    state: 'completion',
    ...(lease.child ? { child: lease.child } : {}),
    ...(lease.phase ? { phase: lease.phase } : {}),
  };
}

/**
 * Wait inside the coordinator for the one physical-host completion owner.
 * This is deliberately separate from the request-key lease: a sibling
 * worktree cannot join its receipt, but it can submit once and wait here
 * without maintaining a shell poll/relaunch loop.
 */
async function acquireCompletionLock({ context, directory, lifetime }) {
  const lock = completionLockDirectory(context.root);
  const queueLock = completionQueueLockDirectory(context.root);
  const ownKey = requestDirectoryKey(directory);
  while (true) {
    if (context.signal?.aborted)
      return { acquired: false, canceled: true, deadlineExpired: false };
    if (context.now() >= context.absoluteDeadline)
      return { acquired: false, canceled: false, deadlineExpired: true };

    const lockStatus = statusForDirectory(lock, {
      now: context.now(),
      staleMs: context.staleMs,
    });
    if (lockStatus && !lockStatus.live && !isSettledLease(lockStatus))
      cleanStaleDirectory(lock, {
        now: context.now(),
        staleMs: context.staleMs,
      });
    cleanStaleCompletionJobs(context.root, {
      now: context.now(),
      staleMs: context.staleMs,
    });

    if (
      completionQueueEligible(context.root, ownKey, {
        now: context.now(),
        staleMs: context.staleMs,
      }) &&
      acquireLeaseDirectory(
        lock,
        completionLeaseProjection(context, lifetime.getLease()),
      )
    ) {
      if (!lifetime.bindCompletionLock(lock))
        throw new Error('lost completion lease while recording owner');
      return { acquired: true, lock };
    }

    // A completed request-key join never reaches this point. Serialize only
    // the decision to become a distinct host-wide completion waiter so two
    // arrivals cannot both observe a spare slot. This mutex never mutates a
    // sibling request lease: ownership remains with each waiting process.
    let queueLockOwned = acquireLeaseDirectory(queueLock, {
      owner: lifetime.getLease().owner,
      heartbeatAt: context.now(),
      state: 'completion_queue',
    });
    if (
      !queueLockOwned &&
      cleanStaleDirectory(queueLock, {
        now: context.now(),
        staleMs: context.staleMs,
      })
    ) {
      queueLockOwned = acquireLeaseDirectory(queueLock, {
        owner: lifetime.getLease().owner,
        heartbeatAt: context.now(),
        state: 'completion_queue',
      });
    }
    if (queueLockOwned) {
      try {
        if (
          completionWaiterCount(context.root, ownKey, {
            now: context.now(),
            staleMs: context.staleMs,
          }) >= MAX_COMPLETION_WAITERS
        ) {
          return { acquired: false, rejected: true, deadlineExpired: false };
        }
        lifetime.setLease({
          ...lifetime.getLease(),
          state: 'queued',
          weight: context.lane.weight,
          phase: undefined,
          queueReason: COMPLETION_QUEUE_REASON,
          completionQueueReserved: true,
          heartbeatAt: context.now(),
        });
        if (lifetime.ownershipLost())
          throw new Error(
            'verification ownership lost while awaiting completion',
          );
      } finally {
        removeOwnedDirectory(queueLock, lifetime.getLease().owner);
      }
    }

    await context.wait(
      Math.min(
        context.heartbeatMs,
        Math.max(1, context.absoluteDeadline - context.now()),
      ),
    );
  }
}

async function acquireHostLease(context) {
  const executionKey = executionEquivalenceKey(context.request);
  const directory = jobDirectory(
    context.root,
    context.force ? `${executionKey}.force-${randomUUID()}` : executionKey,
  );
  const owner = createOwner();
  const leaseBase = {
    request: context.request,
    executionKey,
    owner,
    weight: context.lane.weight,
    capacity: context.capacity,
    worktree: context.before.worktree,
    createdAt: context.now(),
    startedAt: context.now(),
    deadlineAt: context.absoluteDeadline,
    heartbeatAt: context.now(),
    generation: randomUUID(),
    state: 'queued',
    // Full-regression requests become bounded completion waiters only after
    // the queue mutex reserves a slot. New arrivals must not displace an
    // already-reserved waiter merely because their request lease published
    // before their queue decision.
    completionQueueReserved: false,
  };
  let created = acquireLeaseDirectory(directory, leaseBase);
  if (
    !created &&
    cleanStaleDirectory(directory, {
      now: context.now(),
      staleMs: context.staleMs,
    })
  )
    created = acquireLeaseDirectory(directory, leaseBase);
  if (!created && !context.force) {
    const active = statusForDirectory(directory, {
      now: context.now(),
      staleMs: context.staleMs,
    });
    if (active?.state === 'finished') {
      const reused = await reuseFinishedHostLease({ context, lease: active });
      if (reused) return { result: reused };
      removeOwnedDirectory(directory, active.owner);
      created = acquireLeaseDirectory(directory, leaseBase);
    }
    if (!created && active?.state === 'ownership_lost' && active.reclaimable)
      created =
        removeOwnedDirectory(directory, active.owner) &&
        acquireLeaseDirectory(directory, leaseBase);
    if (!created && active?.live) return { directory, active };
  }
  if (!created) throw new Error('unable to acquire verification request lease');
  return { directory, owner, leaseBase };
}

function canceledJoinResult(context) {
  return {
    receipt: createVerificationReceipt({
      request: context.request,
      disposition: 'joined',
      status: 'canceled',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
      before: context.before,
      after: context.before,
    }),
    disposition: 'joined',
    request: context.request,
    queue: [],
  };
}

async function awaitLiveGeneration(context, directory, generation) {
  while (true) {
    const current = statusForDirectory(directory, {
      now: context.now(),
      staleMs: context.staleMs,
    });
    if (current?.generation !== generation) return { kind: 'retry' };
    if (context.signal?.aborted) return { kind: 'canceled' };
    if (current?.state === 'finished')
      return { kind: 'finished', lease: current };
    if (!current?.live) return { kind: 'retry' };
    if (context.now() >= context.absoluteDeadline)
      throw new Error('verification join timed out before owner settlement');
    await context.wait(Math.min(context.heartbeatMs, 100));
  }
}

async function publishJoinedReceipt(context, lease) {
  const ownerReceipt = lease.receiptPath
    ? completedReceipt(
        lease.receiptPath,
        lease.request?.key,
        lease.request?.worktree,
      )
    : null;
  try {
    if (!receiptValidator(ownerReceipt))
      throw new Error('owner receipt failed schema validation');
    assertReceiptSemantics(ownerReceipt);
  } catch {
    throw new Error('owner finished without a valid canonical receipt');
  }
  // station#3584: `context.request.key` was derived from `context.before`,
  // captured at coordinator entry -- before this join's (potentially
  // minutes-long) wait for the owner to settle. `workspaceDigest` hashes the
  // tracked-file diff plus untracked files, so any tracked-file edit during
  // that wait leaves `context.before` describing a tree that no longer
  // exists. Re-deriving the request key from freshly-collected provenance
  // mirrors `reuseFinishedOwnerReceipt`'s pre-projection check: if the
  // joiner's own tree has moved on, the owner's verdict -- however clean --
  // says nothing trustworthy about it. Retry as a fresh request rather than
  // publish a stale-`before` projection; the prior owner has already
  // finished and vacated its job directory, so the retry very likely
  // executes for real instead of joining again. The one provenance snapshot
  // taken here is reused for the receipt's own `after` below, so this check
  // and the receipt's own stability classification can never disagree.
  const after = context.collectProvenance({ cwd: context.cwd });
  if (
    createVerificationRequest(context.request.laneId, after).key !==
    context.request.key
  )
    return retryVerification(context);
  return withArtifactMutation(context, async () => {
    let joined;
    try {
      joined = projectOwnerReceipt(
        ownerReceipt,
        context.request,
        context.before,
        after,
        'joined',
      );
    } catch {
      joined = createVerificationReceipt({
        request: context.request,
        disposition: 'joined',
        status: 'infrastructure_error',
        exitCode: null,
        counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
        cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
        before: context.before,
        after,
      });
    }
    publishCanonicalReceipt({
      worktree: context.before.worktree,
      path: context.canonicalPath,
      receipt: joined,
    });
    return {
      receipt: joined,
      disposition: 'joined',
      request: context.request,
      queue: [],
    };
  });
}

async function joinLiveHostGeneration(context, directory, active) {
  const settlement = await awaitLiveGeneration(
    context,
    directory,
    active.generation,
  );
  if (settlement.kind === 'retry') return retryVerification(context);
  if (settlement.kind === 'canceled') return canceledJoinResult(context);
  return await publishJoinedReceipt(context, settlement.lease);
}

function startLeaseHeartbeat({ context, getLease, setLease }) {
  let timer;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  timer = setInterval(() => {
    if (!setLease({ ...getLease(), heartbeatAt: context.now() })) stop();
  }, context.heartbeatMs);
  return { stop };
}

function publishOwnerResult({
  context,
  directory,
  owner,
  raw,
  timedOut,
  rejected = false,
  getLease,
  onOwnershipLost,
  terminalHooks,
}) {
  const after = context.collectProvenance({ cwd: context.cwd });
  const reportedRaw = attachCiFastDiagnostics(context, raw);
  let result = normalizedResult(raw, {
    canceled: context.signal?.aborted === true,
    timedOut,
    rejected,
  });
  const cleanup = raw?.cleanup ?? {
    status: raw?.cleanupError ? 'failed' : 'not_required',
    survivingOwnedChildren: raw?.survivingOwnedChildren ?? 0,
  };
  const reported = reportExecution({
    raw: reportedRaw,
    result,
    cleanup,
    worktree: context.before.worktree,
    request: context.request,
  });
  result = reported.result;
  const reusableOutputs = reusableOutputBindingsFromRaw(raw, context.lane);
  return publishTerminalReceipt(
    {
      request: context.request,
      force: context.force,
      result,
      artifacts: reported.artifacts,
      cleanup,
      before: context.before,
      after,
      directory,
      outputLock: outputDirectory(context.root, context.request),
      owner,
      lease: getLease(),
      root: context.root,
      staleMs: context.staleMs,
      now: context.now,
      summary: reported.summary,
      outputTruncated: reported.outputTruncated,
      attachmentOmissions: reported.attachmentOmissions,
      reusableOutputs,
      onOwnershipLost,
      terminalHooks,
    },
    {
      assertLeaseOwner,
      commitCanonicalReceipt,
      completedReceipt,
      listJobs,
      pendingReceiptPath,
      quarantineExactReceipt,
      readReceipt,
      receiptCommitPath,
      receiptContents,
      receiptPath,
      withOwnedLeaseMutation,
      writeReceiptAt,
      writeTransactionLease,
    },
  );
}

async function runOwnerAndPublish({
  context,
  directory,
  owner,
  outputLock,
  outputOwned,
  getLease,
  setLease,
  retain,
  onOwnershipLost,
  terminalHooks,
}) {
  const execute =
    context.lane.id === CANONICAL_COMPLETION_LANE
      ? createCompletionPhaseRunner({
          context,
          directory,
          owner,
          outputLock,
          getLease,
          setLease,
          seams: {
            admitAndOwnOutput,
            assertExpectedRequest,
            ensureDirectory,
            privateCommand,
            processIdentity,
            removeOwnedDirectory,
            requestDirectoryKey,
            writeOwnedLease,
          },
        })
      : (context.runner ??
        createOwnedRunner({
          lane: context.lane,
          worktree: context.before.worktree,
          outputLock,
          owner,
          outputOwned,
          now: context.now,
          currentLease: getLease,
          updateLease: setLease,
          privateCommand: (lane) => privateCommand(lane, context.toolchain),
          processIdentity,
          writeOwnedLease,
          env: context.env,
        }));
  const { raw, timedOut } = await runWithinDeadline({
    execute,
    lane: context.lane,
    request: context.request,
    signal: context.signal,
    canceled: getLease().state === 'canceling',
    deadline: context.absoluteDeadline,
    now: context.now,
    fence: () => {
      retain.value = true;
      setLease({ ...getLease(), state: 'fenced', heartbeatAt: context.now() });
    },
  });
  if (raw?.outputRetained) {
    // A completion phase retains the lock only when its owned process did not
    // conclusively settle. Do not turn that fence into a self-wait while
    // attempting terminal publication: the parent must leave no receipt and
    // preserve the output fence for recovery instead.
    retain.value = true;
    throw new Error(
      'verification terminal publication fenced: phase cleanup unresolved',
    );
  }
  let terminalOutputOwned = outputOwned;
  if (!terminalOutputOwned) {
    // No execution capacity is retained while waiting to publish: a final
    // heavy phase may have released its output fence to let a focused sibling
    // finish, and that sibling must not be blocked behind stale capacity.
    setLease({
      ...getLease(),
      state: 'publishing',
      heartbeatAt: context.now(),
    });
    const acquired = await acquireAdmittedOutput({
      outputLock,
      currentLease: getLease,
      now: context.now,
      staleMs: context.staleMs,
      signal: context.signal,
      deadline: context.absoluteDeadline,
      wait: context.wait,
      heartbeatMs: context.heartbeatMs,
    });
    if (!acquired.outputOwned)
      throw new Error(
        'verification terminal publication fenced: output ownership unavailable',
      );
    terminalOutputOwned = true;
  }
  const result = publishOwnerResult({
    context,
    directory,
    owner,
    raw,
    timedOut: timedOut || raw?.deadlineExpired === true,
    getLease,
    onOwnershipLost,
    terminalHooks,
  });
  return { result, outputOwned: terminalOutputOwned };
}

async function acquirePressureTerminalOutput({
  context,
  outputLock,
  lease,
  setLease,
  outputOwned,
}) {
  let owned = outputOwned;
  while (!owned) {
    owned = ownOutput(
      outputLock,
      { ...lease(), state: 'output', heartbeatAt: context.now() },
      { now: context.now(), staleMs: context.staleMs },
    );
    if (owned || context.now() >= context.absoluteDeadline) break;
    await context.wait(
      Math.min(
        context.heartbeatMs,
        Math.max(1, context.absoluteDeadline - context.now()),
      ),
    );
  }
  if (owned) return owned;
  setLease({ ...lease(), state: 'fenced', heartbeatAt: context.now() });
  throw new Error(
    'host-pressure terminal fenced: output ownership unavailable',
  );
}

function pressureTerminalResult({ context, admission, lease, setLease }) {
  if (
    context.signal?.aborted ||
    (admission.canceled && !admission.deadlineExpired)
  ) {
    setLease({ ...lease(), state: 'canceling', heartbeatAt: context.now() });
    return { raw: { status: null, signal: 'SIGTERM' }, timedOut: false };
  }
  if (admission.deadlineExpired) {
    setLease({ ...lease(), state: 'canceling', heartbeatAt: context.now() });
    return { raw: { status: null, signal: 'SIGTERM' }, timedOut: true };
  }
  setLease({ ...lease(), state: 'running', heartbeatAt: context.now() });
  const reason =
    admission.hostPressureOutcome === 'timeout'
      ? 'host_pressure_timeout'
      : 'host_pressure_unavailable';
  return {
    raw: {
      status: null,
      error: new Error(reason),
      output: { stdout: { text: '' }, stderr: { text: '' } },
    },
    timedOut: false,
  };
}

async function publishPressureTerminal({
  context,
  admission,
  directory,
  owner,
  outputLock,
  outputOwned,
  getLease,
  setLease,
  onOutputOwned,
  onOwnershipLost,
  terminalHooks,
}) {
  const terminalOutputOwned = await acquirePressureTerminalOutput({
    context,
    outputLock,
    lease: getLease,
    setLease,
    outputOwned,
  });
  // Publication can throw after the output fence is acquired. Record it in
  // the shared lifetime before that fallible work so cleanup always releases
  // this owner's lock rather than leaving a retry fenced behind it.
  onOutputOwned?.(terminalOutputOwned);
  const { raw, timedOut } = pressureTerminalResult({
    context,
    admission,
    lease: getLease,
    setLease,
  });
  return {
    outputOwned: terminalOutputOwned,
    result: publishOwnerResult({
      context,
      directory,
      owner,
      raw,
      timedOut,
      getLease,
      onOwnershipLost,
      terminalHooks,
    }),
  };
}

async function executeAfterAdmission({
  context,
  admission,
  directory,
  owner,
  outputLock,
  outputOwned,
  getLease,
  setLease,
  retain,
  onOwnershipLost,
  terminalHooks,
}) {
  // A detached submission pins the request it handed off. Recompute immediately
  // before any raw phase can start, so queue time cannot turn a request for one
  // worktree state into execution against another.
  assertExpectedRequest({
    lane: context.lane,
    cwd: context.cwd,
    collectProvenance: context.collectProvenance,
    expectedRequest: context.expectedRequest,
    stage: 'execution',
  });
  let owned = outputOwned;
  if (admission.canceled && !owned && !admission.deadlineExpired)
    owned = ownOutput(
      outputLock,
      { ...getLease(), state: 'output', heartbeatAt: context.now() },
      { now: context.now(), staleMs: context.staleMs },
    );
  setLease({
    ...getLease(),
    state: admission.canceled
      ? 'canceling'
      : context.lane.id === CANONICAL_COMPLETION_LANE
        ? 'orchestrating'
        : 'running',
    heartbeatAt: context.now(),
  });
  if (admission.deadlineExpired && !owned) {
    setLease({ ...getLease(), state: 'fenced', heartbeatAt: context.now() });
    throw new Error('verification deadline expired before output ownership');
  }
  const published = await runOwnerAndPublish({
    context,
    directory,
    owner,
    outputLock,
    outputOwned: owned,
    getLease,
    setLease,
    retain,
    onOwnershipLost,
    terminalHooks,
  });
  return {
    result: published.result,
    outputOwned: owned || published.outputOwned,
  };
}

/** One lease lifetime owns the heartbeat, abort fence, output lock, and cleanup. */
function createOwnedLeaseLifetime(context, { directory, owner, leaseBase }) {
  let lease = leaseBase;
  let outputOwned = false;
  let completionLock = null;
  const outputLock = outputDirectory(context.root, context.request);
  const ownershipController = new AbortController();
  const forwardAbort = () => ownershipController.abort();
  context.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (context.signal?.aborted) ownershipController.abort();
  const ownerContext = { ...context, signal: ownershipController.signal };
  const retain = { value: false };
  let ownershipLost = false;
  let heartbeat;
  const loseOwnership = ({ reclaimable = false } = {}) => {
    if (ownershipLost) return;
    ownershipLost = true;
    retain.value = true;
    heartbeat?.stop();
    ownershipController.abort();
    // Best-effort by contract (#3287): these are lease WRITES, and the most
    // likely reason to reach this path is a host that can no longer write
    // (ENOSPC). An exception here would escape a heartbeat setInterval as an
    // uncaught crash; the stale lease is instead reclaimed by successors.
    markOwnershipLostBestEffort({
      root: ownerContext.root,
      directory,
      owner,
      now: ownerContext.now,
      reclaimable,
      completionLock,
      outputLock: outputOwned ? outputLock : null,
    });
  };
  const setLease = (next) => {
    lease = next;
    if (ownershipLost) return false;
    try {
      const requestWritten = writeOwnedLease(directory, owner, lease);
      const completionWritten =
        !completionLock ||
        writeOwnedLease(
          completionLock,
          owner,
          completionLeaseProjection(ownerContext, lease),
        );
      if (requestWritten && completionWritten) return true;
    } catch {
      // Lease replication failures are ownership loss, never a retryable pass.
    }
    loseOwnership();
    return false;
  };
  heartbeat = startLeaseHeartbeat({
    context: ownerContext,
    getLease: () => lease,
    setLease,
  });
  return {
    ownerContext,
    outputLock,
    retain,
    getLease: () => lease,
    setLease,
    loseOwnership,
    ownershipLost: () => ownershipLost,
    outputOwned: () => outputOwned,
    bindCompletionLock: (lock) => {
      completionLock = lock;
      try {
        return writeOwnedLease(
          completionLock,
          owner,
          completionLeaseProjection(ownerContext, lease),
        );
      } catch {
        return false;
      }
    },
    setOutputOwned: (next) => {
      outputOwned = next;
    },
    releaseOutputOwnership: () => {
      if (!outputOwned) return true;
      if (!removeOwnedDirectory(outputLock, owner)) return false;
      outputOwned = false;
      return true;
    },
    cleanup: () => {
      context.signal?.removeEventListener('abort', forwardAbort);
      heartbeat.stop();
      if (outputOwned && !retain.value) removeOwnedDirectory(outputLock, owner);
      if (completionLock && !retain.value)
        removeOwnedDirectory(completionLock, owner);
    },
  };
}

function admitOwnedLease(lifetime, directory, owner) {
  const { ownerContext, outputLock, getLease, setLease } = lifetime;
  return admitAndOwnOutput({
    root: ownerContext.root,
    directoryKey: requestDirectoryKey(directory),
    owner,
    lane: ownerContext.lane,
    capacity: ownerContext.capacity,
    outputLock,
    staleMs: ownerContext.staleMs,
    signal: ownerContext.signal,
    deadline: ownerContext.absoluteDeadline,
    heartbeatMs: ownerContext.heartbeatMs,
    wait: ownerContext.wait,
    now: ownerContext.now,
    currentLease: getLease,
    updateLease: setLease,
    hostPressureGated: ownerContext.hostPressureGated,
    hostCpuSampler: ownerContext.hostCpuSampler,
    hostPressureWaitMs: ownerContext.hostPressureWaitMs,
    deferOutputOwnership: ownerContext.lane.id === CANONICAL_COMPLETION_LANE,
  });
}

async function publishAdmittedLease({ lifetime, admission, directory, owner }) {
  const {
    ownerContext,
    outputLock,
    getLease,
    setLease,
    retain,
    loseOwnership,
  } = lifetime;
  const options = {
    context: ownerContext,
    admission,
    directory,
    owner,
    outputLock,
    outputOwned: lifetime.outputOwned(),
    getLease,
    setLease,
    onOutputOwned: lifetime.setOutputOwned,
    onOwnershipLost: loseOwnership,
    terminalHooks: ownerContext.terminalHooks,
  };
  return ownerContext.hostPressureGated && !admission.admitted
    ? publishPressureTerminal(options)
    : executeAfterAdmission({ ...options, retain });
}

/** Publish a bounded host-completion wait without invoking any phase runner. */
async function publishCompletionQueueTerminal({
  lifetime,
  admission,
  directory,
  owner,
}) {
  const {
    ownerContext: context,
    outputLock,
    getLease,
    setLease,
    loseOwnership,
  } = lifetime;
  const outputOwned = await acquirePressureTerminalOutput({
    context,
    outputLock,
    lease: getLease,
    setLease,
    outputOwned: lifetime.outputOwned(),
  });
  lifetime.setOutputOwned(outputOwned);
  setLease({ ...getLease(), state: 'canceling', heartbeatAt: context.now() });
  const result = publishOwnerResult({
    context,
    directory,
    owner,
    raw: { status: null, signal: 'SIGTERM' },
    timedOut: admission.deadlineExpired,
    rejected: admission.rejected === true,
    getLease,
    onOwnershipLost: loseOwnership,
    terminalHooks: context.terminalHooks,
  });
  return { result, outputOwned };
}

/**
 * The owner lifetime remains one scope because its heartbeat, output lease,
 * child identity, terminal receipt, and cleanup must all fence the same lease.
 */
async function executeOwnedHostLease(context, { directory, owner, leaseBase }) {
  return withArtifactMutation(context, async () => {
    const lifetime = createOwnedLeaseLifetime(context, {
      directory,
      owner,
      leaseBase,
    });
    try {
      if (context.lane.id === CANONICAL_COMPLETION_LANE) {
        const completion = await acquireCompletionLock({
          context: lifetime.ownerContext,
          directory,
          lifetime,
        });
        if (!completion.acquired) {
          const published = await publishCompletionQueueTerminal({
            lifetime,
            admission: completion,
            directory,
            owner,
          });
          lifetime.setOutputOwned(published.outputOwned);
          return published.result;
        }
      }
      const admission = await admitOwnedLease(lifetime, directory, owner);
      // Admission can acquire the output fence immediately before a request
      // lease write discovers replacement. Persist that ownership in the
      // lifetime first so the ownership-loss path releases the fence rather
      // than leaking it behind a rejected admission.
      lifetime.setOutputOwned(admission.outputOwned);
      if (lifetime.ownershipLost()) {
        // No runner was admitted, so an output fence acquired by this exact
        // owner has no child state to preserve for recovery.
        lifetime.releaseOutputOwnership();
        throw new Error('verification ownership lost during admission');
      }
      const published = await publishAdmittedLease({
        lifetime,
        admission,
        directory,
        owner,
      });
      lifetime.setOutputOwned(published.outputOwned);
      return published.result;
    } finally {
      lifetime.cleanup();
    }
  });
}

/** Public orchestration outline: context, local reuse, host reuse/join, execution. */
export async function coordinateVerification(options = {}) {
  return coordinateHostVerification(options);
}

async function coordinateHostVerification(options = {}) {
  const context = prepareCoordinatorContext(options);
  // Local reuse is ordinarily read-only, but an invalid reusable-output
  // receipt is quarantined and replaced with a tombstone. Fence that narrow
  // mutation-capable path, then release before any host join/retry wait.
  let local = localReuseResult(context, { allowQuarantine: false });
  if (local?.needsArtifactMutation)
    local = await withArtifactMutation(context, async () =>
      localReuseResult(context),
    );
  if (local) return local;

  const acquisition = await acquireHostLease(context);
  if (acquisition.result) return acquisition.result;
  if (acquisition.active)
    return joinLiveHostGeneration(
      context,
      acquisition.directory,
      acquisition.active,
    );
  return executeOwnedHostLease(context, acquisition);
}

export function verificationStatus({
  root = defaultCoordinatorRoot(),
  staleMs = STALE_MS,
  capacity = DEFAULT_CAPACITY,
  processIdentityFn,
  now = Date.now(),
} = {}) {
  const jobs = listJobs(root, {
    staleMs,
    ...(processIdentityFn ? { processIdentityFn } : {}),
  });
  const timedJobs = jobs.map((job) => {
    const phase = job.phase;
    const startedAt = job.startedAt ?? job.createdAt;
    const deadlineAt = job.deadlineAt;
    return {
      ...job,
      ...(Number.isFinite(startedAt)
        ? { elapsedMs: Math.max(0, now - startedAt) }
        : {}),
      ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
      ...(phase
        ? {
            phase: {
              ...phase,
              ...(Number.isFinite(phase.queueStartedAt)
                ? { queueElapsedMs: Math.max(0, now - phase.queueStartedAt) }
                : {}),
              ...(Number.isFinite(phase.queueDeadlineAt)
                ? { queueDeadlineAt: phase.queueDeadlineAt }
                : {}),
              ...(Number.isFinite(phase.executionStartedAt)
                ? {
                    executionElapsedMs: Math.max(
                      0,
                      now - phase.executionStartedAt,
                    ),
                  }
                : {}),
              ...(Number.isFinite(phase.executionDeadlineAt)
                ? { executionDeadlineAt: phase.executionDeadlineAt }
                : {}),
            },
          }
        : {}),
    };
  });
  const activeJobs = timedJobs.filter(
    (job) => job.live && CAPACITY_CONSUMING_STATES.has(job.state),
  );
  const queuedJobs = timedJobs.filter(
    (job) => job.live && job.state === 'queued',
  );
  const usedWeight = activeJobs.reduce((sum, job) => sum + job.weight, 0);
  const knownQueuedPressure = queuedJobs
    .map((job) => job.hostPressure?.status)
    .filter(Boolean);
  const diagnosticJobs = [...queuedJobs].sort(
    (left, right) =>
      (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
      String(left.key).localeCompare(String(right.key)),
  );
  const healthyIdleQueue =
    usedWeight === 0 &&
    queuedJobs.length > 0 &&
    knownQueuedPressure.length === queuedJobs.length &&
    knownQueuedPressure.every((status) => status === 'healthy');
  return {
    capacity: jobs[0]?.capacity ?? capacity,
    usedWeight,
    waiting: queuedJobs.length,
    ...(healthyIdleQueue
      ? {
          noProgress: {
            reason: 'healthy_idle_queue',
            blockers: diagnosticJobs.slice(0, 8).map((job) => ({
              requestKey: job.key,
              queueReason: job.queueReason ?? 'unspecified',
              blockingRequestKey: job.blockingRequestKey ?? null,
            })),
            truncated: queuedJobs.length > 8,
          },
        }
      : {}),
    jobs: timedJobs,
    retention: verificationRetentionInventory({ root, now }),
  };
}

export function explainVerification({
  laneId,
  cwd = process.cwd(),
  root = defaultCoordinatorRoot(),
} = {}) {
  const provenance = collectVerificationProvenance({ cwd });
  const request = createVerificationRequest(laneId, provenance);
  const lane = resolveLane(laneId);
  return {
    request,
    lane: {
      id: lane.id,
      command: lane.command,
      weight: lane.weight,
      ownedOutputs: lane.ownedOutputs,
    },
    canonicalReceipt: receiptPath(provenance.worktree, request.key, false),
    status: verificationStatus({ root }),
  };
}

// Narrow test seam: tests use the real filesystem primitives without
// duplicating their atomicity protocol in a separate helper.
export const __verificationCoordinatorInternals = {
  assertExpectedRequest,
  attachCiFastDiagnostics,
  acquireLeaseDirectory,
  createOwnedDirectoryRemover,
  removeOwnedDirectory,
  removeOwnedDirectoryOutcome,
  cleanStaleDirectory,
  gcFinishedLeases,
  acquireMutationClaim,
  recoverMutationClaim,
  releaseMutationClaim,
  outputDirectory,
  jobDirectory,
  writeOwnedLease,
  requestDirectoryKey,
  projectLaneReusableOutputs,
  recoverExactChild,
};
