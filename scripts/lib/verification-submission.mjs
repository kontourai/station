import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeExactProcessIdentity } from '../../packages/shared/src/process-identity.mjs';
import { CANONICAL_COMPLETION_LANE } from '../verification-lanes.mjs';
import {
  assertVerificationToolchain,
  collectVerificationProvenance,
  resolveVerificationToolchain,
  verificationExecutionEnvironment,
} from './test-reliability.mjs';
import {
  coordinateVerification,
  defaultCoordinatorRoot,
} from './verification-coordinator.mjs';
import { assertInstalledDependenciesMatchLockfile } from './verification-environment-preflight.mjs';
import { createVerificationRequest } from './verification-receipt.mjs';
import { redactVerificationOutput } from './verification-redaction.mjs';
import {
  terminalHandoffGCSummaryPath,
  terminalHandoffRetentionCandidates,
  verificationRetentionInventory,
} from './verification-retention-inventory.mjs';
import {
  classifyCoordinatingWorker,
  currentWorkerIdentity,
} from './verification-worker-identity.mjs';

const HANDOFF_DIRECTORY = 'submissions';
const HANDOFF_FILE = 'handoff.json';
const HANDOFF_READY_TIMEOUT_MS = 5_000;
const REQUEST_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LAUNCH_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RETRY_CLAIM_FILE = 'lease.json';
const TERMINAL_HANDOFF_STATES = new Set([
  'failed_to_start',
  'stale_before_execution',
  'settled',
]);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows does not implement POSIX modes.
  }
}

function writeJsonAtomic(path, value, { rename = renameSync } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows does not implement POSIX modes.
  }
  try {
    rename(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Fail closed even if cleanup is unavailable.
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes.
  }
}

function writeSummaryJsonAtomic(path, value, gcHooks) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  const replace = gcHooks?.renameSync ?? renameSync;
  try {
    replace(temporary, path);
  } catch (error) {
    if (
      error?.code !== 'EPERM' ||
      (gcHooks?.platform ?? process.platform) !== 'win32' ||
      !existsSync(path)
    ) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve fail-closed behavior if cleanup is unavailable.
      }
      throw error;
    }
    // Only this non-critical summary may briefly move its old destination
    // aside on Win32. Handoff/claim publication always fails closed instead.
    const previous = `${path}.previous-${randomUUID()}`;
    try {
      gcHooks?.onSummaryDestinationRetire?.({ path, previous });
      replace(path, previous);
      replace(temporary, path);
    } catch (replaceError) {
      if (!existsSync(path)) {
        try {
          replace(previous, path);
        } catch {
          // A missing lastSweep is safer than inventing a successful sweep.
        }
      }
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve fail-closed behavior if cleanup is unavailable.
      }
      throw replaceError;
    }
    try {
      rmSync(previous, { force: true });
    } catch {
      // The new summary is authoritative; a later summary can reclaim it.
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function handoffPath(directory) {
  return join(directory, HANDOFF_FILE);
}

function assertRequestKey(requestKey) {
  if (typeof requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(requestKey))
    throw new Error(
      'verification submission request key must be 64 lowercase hexadecimal characters',
    );
  return requestKey;
}

function handoffDirectory(root, requestKey) {
  return join(root, HANDOFF_DIRECTORY, assertRequestKey(requestKey));
}

function canonicalReceiptPath(request) {
  return join(
    request.worktree,
    '.kontourai',
    'verification-receipts',
    `${request.key}.canonical.json`,
  );
}

function sameRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readHandoff(directory) {
  return readJson(handoffPath(directory));
}

function createLaunchToken() {
  return randomBytes(16).toString('hex');
}

function hasLaunchToken(value) {
  return typeof value === 'string' && LAUNCH_TOKEN_PATTERN.test(value);
}

function launchTokenArgument(launchToken) {
  return `--verification-launch-token=${launchToken}`;
}

function createHandoff({ request, now = Date.now, generation = 1 }) {
  return {
    schemaVersion: 1,
    request,
    generation,
    launchToken: createLaunchToken(),
    state: 'launching',
    createdAt: now(),
    updatedAt: now(),
    receiptPath: canonicalReceiptPath(request),
  };
}

function retryGeneration(handoff) {
  return Number.isInteger(handoff?.generation) && handoff.generation >= 1
    ? handoff.generation + 1
    : 2;
}

function retryClaimDirectory(directory) {
  return `${directory}.retry-claim`;
}

function processIdentity(pid) {
  const probe = probeExactProcessIdentity(pid);
  return probe.state === 'exact'
    ? probe.identity
    : probe.state === 'unavailable'
      ? { pid, start: null, unavailable: true }
      : null;
}

function retryClaimIsLive(claim) {
  const owner = claim?.owner;
  const actual = processIdentity(owner?.pid);
  if (!actual) return false;
  if (actual.unavailable) return true;
  return !owner.processStart || actual.start === owner.processStart;
}

function retryClaimMatches(left, right) {
  return left?.owner?.nonce === right?.owner?.nonce;
}

function quarantineDeadRetryClaim(claimDirectory, expected) {
  const quarantine = `${claimDirectory}.reclaim-${expected?.owner?.nonce ?? 'invalid'}-${randomUUID()}`;
  try {
    renameSync(claimDirectory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT' || existsSync(claimDirectory)) return false;
    throw error;
  }
  const current = readJson(join(quarantine, RETRY_CLAIM_FILE));
  if (retryClaimMatches(current, expected) && !retryClaimIsLive(current)) {
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  }
  // A successor may have published the canonical name while this quarantined
  // directory was being inspected. Never replace that successor in place.
  if (!existsSync(claimDirectory)) {
    try {
      renameSync(quarantine, claimDirectory);
    } catch {
      // A successor owns the canonical claim name.
    }
  }
  return false;
}

function acquireRetryClaim({ directory, now = Date.now, retryHooks }) {
  const claimDirectory = retryClaimDirectory(directory);
  const identity = processIdentity(process.pid);
  if (identity?.unavailable)
    return { owned: false, claimDirectory, unavailable: true };
  const claim = {
    owner: {
      pid: process.pid,
      processStart: identity?.start ?? null,
      nonce: randomUUID(),
    },
    createdAt: now(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const staged = `${claimDirectory}.claim-${randomUUID()}`;
    try {
      // Publish an initialized claim directory in one rename. A bare mkdir
      // would let another contender mistake the pre-write directory for a
      // dead owner and delete a live claim.
      mkdirSync(staged, { mode: 0o700 });
      writeJsonAtomic(join(staged, RETRY_CLAIM_FILE), claim);
      retryHooks?.afterRetryClaimStaged?.({
        staged,
        claimDirectory,
        claim,
      });
      renameSync(staged, claimDirectory);
      return { owned: true, claimDirectory, claim };
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      if (error?.code !== 'EEXIST' && !existsSync(claimDirectory)) throw error;
      const existing = readJson(join(claimDirectory, RETRY_CLAIM_FILE));
      if (retryClaimIsLive(existing)) return { owned: false, claimDirectory };
      retryHooks?.beforeRetryClaimQuarantine?.({
        claimDirectory,
        claim: existing,
      });
      if (!quarantineDeadRetryClaim(claimDirectory, existing))
        return { owned: false, claimDirectory };
    }
  }
  return { owned: false, claimDirectory };
}

function releaseRetryClaim({ claimDirectory, claim }) {
  const current = readJson(join(claimDirectory, RETRY_CLAIM_FILE));
  if (current?.owner?.nonce !== claim?.owner?.nonce) return;
  try {
    rmSync(claimDirectory, { recursive: true, force: true });
  } catch {
    // The next generation is already published. A retained claim cannot block
    // its parent/worker path and is reclaimed after this owner exits.
  }
}

function terminalHandoffFingerprint(handoff) {
  return JSON.stringify(handoff);
}

function writeTerminalHandoffGCSummary(root, summary, gcHooks) {
  try {
    gcHooks?.writeSummary?.({ root, summary });
    ensureDirectory(root);
    writeSummaryJsonAtomic(
      terminalHandoffGCSummaryPath(root),
      summary,
      gcHooks,
    );
  } catch {
    throw new Error(
      'verification terminal-handoff GC summary persistence failed',
    );
  }
}

/**
 * Removes only an exact, terminal submission handoff selected from a complete
 * bounded inventory. The retry claim is the shared mutation boundary: a retry
 * or fresh exact-key submit waits while the old handoff is quarantined.
 */
export function sweepTerminalSubmissionHandoffs({
  root = defaultCoordinatorRoot(),
  now = Date.now,
  policy,
  gcHooks,
} = {}) {
  const at = now();
  const selection = terminalHandoffRetentionCandidates({
    root,
    now: at,
    policy,
  });
  const summary = {
    at,
    removed: 0,
    skipped: selection.scan.invalidSkipped,
    truncated: selection.scan.truncated,
    nonactionable: !selection.complete,
  };
  if (!selection.complete) {
    writeTerminalHandoffGCSummary(root, summary, gcHooks);
    return summary;
  }

  const permitted = selection.candidates.slice(0, selection.policy.removeLimit);
  summary.skipped += selection.candidates.length - permitted.length;
  for (const candidate of permitted) {
    const directory = join(root, HANDOFF_DIRECTORY, candidate.key);
    const expected = terminalHandoffFingerprint(candidate.handoff);
    const claim = acquireRetryClaim({
      directory,
      now,
      retryHooks: gcHooks?.retryHooks,
    });
    if (!claim.owned) {
      summary.skipped += 1;
      continue;
    }
    try {
      const current = readHandoff(directory);
      if (terminalHandoffFingerprint(current) !== expected) {
        summary.skipped += 1;
        continue;
      }
      gcHooks?.beforeQuarantine?.({ directory, candidate, claim: claim.claim });
      if (terminalHandoffFingerprint(readHandoff(directory)) !== expected) {
        summary.skipped += 1;
        continue;
      }
      const quarantine = `${directory}.gc-${claim.claim.owner.nonce}-${randomUUID()}`;
      try {
        renameSync(directory, quarantine);
      } catch {
        summary.skipped += 1;
        continue;
      }
      gcHooks?.afterQuarantine?.({
        directory,
        quarantine,
        candidate,
        claim: claim.claim,
      });
      if (terminalHandoffFingerprint(readHandoff(quarantine)) !== expected) {
        summary.skipped += 1;
        continue;
      }
      gcHooks?.beforeDelete?.({
        directory,
        quarantine,
        candidate,
        claim: claim.claim,
      });
      if (terminalHandoffFingerprint(readHandoff(quarantine)) !== expected) {
        summary.skipped += 1;
        continue;
      }
      rmSync(quarantine, { recursive: true, force: true });
      summary.removed += 1;
    } finally {
      releaseRetryClaim(claim);
    }
  }
  writeTerminalHandoffGCSummary(root, summary, gcHooks);
  return summary;
}

function isRetryableRejectedHandoff(handoff, request) {
  return (
    sameRequest(handoff?.request, request) &&
    handoff?.state === 'settled' &&
    handoff?.terminal?.status === 'rejected' &&
    handoff.terminal.passed === false
  );
}

/**
 * A rejected coordinator result has no active worker or output owner. A
 * sibling claim directory fences one retry winner while retaining the canonical
 * handoff path throughout the transition. That lets contenders wait or join
 * instead of observing a missing exact-key directory.
 */
function retryRejectedHandoff({
  directory,
  request,
  now = Date.now,
  retryHooks,
  claim: existingClaim,
}) {
  const current = readHandoff(directory);
  if (!isRetryableRejectedHandoff(current, request)) return null;
  const claim =
    existingClaim ?? acquireRetryClaim({ directory, now, retryHooks });
  if (!claim.owned) return { acquired: false, directory, retrying: true };
  try {
    const claimed = readHandoff(directory);
    if (!isRetryableRejectedHandoff(claimed, request))
      return { acquired: false, directory };
    retryHooks?.afterRetryClaim?.({ directory, claim: claim.claim });
    const handoff = createHandoff({
      request,
      now,
      generation: retryGeneration(claimed),
    });
    writeJsonAtomic(handoffPath(directory), handoff);
    return { acquired: true, directory, handoff };
  } finally {
    if (!existingClaim) releaseRetryClaim(claim);
  }
}

/** Directory publication is the per-request submission ownership boundary. */
function acquireHandoff({
  root,
  request,
  now = Date.now,
  retryHooks,
  handoffHooks,
} = {}) {
  ensureDirectory(join(root, HANDOFF_DIRECTORY));
  const directory = handoffDirectory(root, request.key);
  const handoff = createHandoff({ request, now });
  // Fresh publication and retry/GC mutations share this same sibling claim.
  // A check-before-rename is racy: GC could quarantine the canonical directory
  // between that check and publication. Holding the claim closes that window.
  const publication = acquireRetryClaim({ directory, now, retryHooks });
  if (!publication.owned) return { acquired: false, directory, retrying: true };
  try {
    handoffHooks?.afterClaim?.({ directory, claim: publication.claim });
    if (!existsSync(directory)) {
      const staged = `${directory}.claim-${randomUUID()}`;
      try {
        mkdirSync(staged, { mode: 0o700 });
        writeJsonAtomic(handoffPath(staged), handoff);
        renameSync(staged, directory);
        return { acquired: true, directory, handoff };
      } catch (error) {
        rmSync(staged, { recursive: true, force: true });
        if (!existsSync(directory)) throw error;
      }
    }
    const existing = readHandoff(directory);
    if (!existing) return { acquired: false, directory, retrying: true };
    if (!sameRequest(existing.request, request))
      throw new Error('verification handoff ownership collision');
    const retry = retryRejectedHandoff({
      directory,
      request,
      now,
      retryHooks,
      claim: publication,
    });
    if (retry) return retry;
    return { acquired: false, directory, handoff: existing };
  } finally {
    releaseRetryClaim(publication);
  }
}

function updateHandoff(directory, update, now = Date.now) {
  const current = readHandoff(directory);
  if (!current) throw new Error('verification handoff is unavailable');
  const next = { ...current, ...update, updatedAt: now() };
  writeJsonAtomic(handoffPath(directory), next);
  return next;
}

/**
 * The submitting parent is the only process that can publish a ready worker.
 * This synchronous read/write is atomic with respect to the parent's timeout
 * callback: a late readiness message cannot overwrite a terminal timeout.
 */
function coordinateReadyWorker(directory, worker, now = Date.now) {
  if (typeof worker?.nonce !== 'string' || !worker.nonce)
    throw new Error('verification worker readiness did not include a nonce');
  const current = readHandoff(directory);
  if (!current?.request) throw new Error('verification handoff is unavailable');
  if (
    !hasLaunchToken(current.launchToken) ||
    worker?.launchToken !== current.launchToken
  )
    throw new Error('verification worker readiness launch token did not match');
  if (current.state !== 'launching')
    throw new Error(
      'verification handoff is no longer available for readiness',
    );
  return updateHandoff(directory, { state: 'coordinating', worker }, now);
}

function updateCoordinatingWorkerHandoff({
  directory,
  workerGeneration,
  workerNonce,
  update,
  now = Date.now,
}) {
  const claim = acquireRetryClaim({ directory, now });
  if (!claim.owned)
    throw new Error(
      'verification handoff is unavailable for worker settlement',
    );
  try {
    const current = readHandoff(directory);
    if (
      current?.state !== 'coordinating' ||
      current.generation !== workerGeneration ||
      current.worker?.nonce !== workerNonce
    ) {
      throw new Error('verification worker no longer owns the handoff');
    }
    return updateHandoff(directory, update, now);
  } finally {
    releaseRetryClaim(claim);
  }
}

function recoverCoordinatingHandoff({
  directory,
  request,
  now = Date.now,
  identityProbe,
  recoveryHooks,
}) {
  const claim = acquireRetryClaim({ directory, now });
  if (!claim.owned) return { retrying: true, directory };
  try {
    const current = readHandoff(directory);
    if (
      !current ||
      !sameRequest(current.request, request) ||
      current.state !== 'coordinating'
    )
      return { unavailable: true, directory };
    const classification = classifyCoordinatingWorker(
      current.worker,
      identityProbe,
    );
    if (classification === 'live') return { live: true, directory };
    if (classification !== 'recoverable')
      return { unavailable: true, directory };
    const handoff = createHandoff({
      request,
      now,
      generation: retryGeneration(current),
    });
    recoveryHooks?.beforeRecoveryPublication?.({
      directory,
      current,
      handoff,
      claim: claim.claim,
    });
    // The claim serializes recovery against worker settlement. Replacing only
    // the handoff file preserves the exact-key directory for contenders.
    writeJsonAtomic(handoffPath(directory), handoff);
    return { acquired: true, directory, handoff, recovered: true };
  } catch {
    return { unavailable: true, directory };
  } finally {
    releaseRetryClaim(claim);
  }
}

function acceptedResult(handoff, directory, disposition) {
  return {
    status: 'accepted',
    evidence: false,
    disposition,
    requestKey: handoff.request.key,
    handoffPath: handoffPath(directory),
    canonicalReceipt: handoff.receiptPath,
    statusCommand: `node scripts/run-verification.mjs submit-status ${handoff.request.key}`,
  };
}

function nonAcceptedResult(handoff, directory) {
  return {
    status: handoff.state,
    evidence: false,
    ...(handoff.request?.key ? { requestKey: handoff.request.key } : {}),
    handoffPath: handoffPath(directory),
    ...(handoff.receiptPath ? { canonicalReceipt: handoff.receiptPath } : {}),
    statusCommand:
      `node scripts/run-verification.mjs submit-status ${handoff.request?.key ?? ''}`.trim(),
    ...(handoff.error ? { error: errorText(handoff.error) } : {}),
  };
}

export function verificationSubmissionStatus({
  root = defaultCoordinatorRoot(),
  requestKey,
  now = Date.now(),
  identityProbe = currentWorkerIdentity,
} = {}) {
  if (requestKey !== undefined) assertRequestKey(requestKey);
  const directory = join(root, HANDOFF_DIRECTORY);
  const keys = requestKey
    ? [requestKey]
    : (() => {
        try {
          return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((key) => REQUEST_KEY_PATTERN.test(key))
            .sort();
        } catch {
          return [];
        }
      })();
  return {
    submissions: keys.slice(0, 32).map((key) => {
      const handoff = readHandoff(handoffDirectory(root, key));
      const workerClassification =
        handoff?.state === 'coordinating'
          ? classifyCoordinatingWorker(handoff.worker, identityProbe)
          : null;
      return handoff?.request
        ? {
            requestKey: handoff.request.key,
            state: handoff.state,
            ...(handoff.worker
              ? {
                  worker: {
                    pid: handoff.worker.pid,
                    startedAt: handoff.worker.startedAt,
                  },
                }
              : {}),
            ...(handoff.state === 'coordinating'
              ? {
                  recovery:
                    workerClassification === 'recoverable'
                      ? 'recoverable'
                      : workerClassification === 'live'
                        ? 'live'
                        : 'identity_unavailable',
                }
              : {}),
            ...(handoff.receiptPath
              ? { canonicalReceipt: handoff.receiptPath }
              : {}),
            ...(handoff.terminal
              ? {
                  terminal: {
                    status: handoff.terminal.status,
                    passed: handoff.terminal.passed === true,
                    // station#3584: without this, a poller of this exact
                    // surface (the full-regression handoff a caller submits
                    // and then polls) cannot tell an unsupported `false` from
                    // a genuine one and has no signal to re-run rather than
                    // diagnose.
                    ...(handoff.terminal.indeterminate === true
                      ? { indeterminate: true }
                      : {}),
                  },
                }
              : {}),
            ...(handoff.error ? { error: errorText(handoff.error) } : {}),
          }
        : { requestKey: key, state: 'not_found' };
    }),
    truncated: keys.length > 32,
    retention: verificationRetentionInventory({ root, now }),
  };
}

function errorText(error) {
  const message = redactVerificationOutput(
    String(error instanceof Error ? error.message : error),
  );
  return message
    .replace(/(^|[\s("'])\/(?:[^\s"'`(),;]+\/)*[^\s"'`(),;]+/g, '$1[PATH]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`(),;]+\\)*[^\s"'`(),;]+/g, '[PATH]')
    .slice(0, 512);
}

export function redactVerificationSubmissionError(error) {
  return errorText(error);
}

function failHandoff(
  directory,
  error,
  {
    now = Date.now,
    state = 'failed_to_start',
    workerNonce,
    workerGeneration,
  } = {},
) {
  try {
    const current = readHandoff(directory);
    if (!current || TERMINAL_HANDOFF_STATES.has(current.state)) return current;
    if (workerNonce && current.generation !== workerGeneration) return current;
    if (workerNonce && current.state === 'coordinating') {
      try {
        return updateCoordinatingWorkerHandoff({
          directory,
          workerGeneration,
          workerNonce,
          update: { state, error: errorText(error) },
          now,
        });
      } catch {
        return readHandoff(directory);
      }
    }
    return updateHandoff(directory, { state, error: errorText(error) }, now);
  } catch {
    return null;
  }
}

function awaitWorkerReadiness({ child, timeoutMs }) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('message', onMessage);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === 'verification-submission-ready')
        settle(resolveReady, message);
      else if (message?.type === 'verification-submission-failed')
        settle(
          rejectReady,
          new Error(message.error || 'worker rejected handoff'),
        );
    };
    const onError = (error) => settle(rejectReady, error);
    const onExit = (code, signal) =>
      settle(
        rejectReady,
        new Error(
          `verification submission worker exited before readiness (${code ?? signal ?? 'unknown'})`,
        ),
      );
    const timer = setTimeout(
      () =>
        settle(
          rejectReady,
          new Error('verification submission readiness handshake timed out'),
        ),
      timeoutMs,
    );
    child.on?.('message', onMessage);
    child.once?.('error', onError);
    child.once?.('exit', onExit);
  });
}

function acknowledgeWorker(child, worker) {
  if (typeof child.send !== 'function')
    return Promise.reject(new Error('verification worker IPC is unavailable'));
  return new Promise((resolveAcknowledged, rejectAcknowledged) => {
    try {
      child.send(
        { type: 'verification-submission-ack', workerNonce: worker?.nonce },
        (error) => (error ? rejectAcknowledged(error) : resolveAcknowledged()),
      );
    } catch (error) {
      rejectAcknowledged(error);
    }
  });
}

async function awaitHandoffState({
  directory,
  timeoutMs,
  now = Date.now,
  wait = sleep,
}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const handoff = readHandoff(directory);
    if (!handoff?.request)
      return { status: 'handoff_unavailable', evidence: false };
    if (handoff.state === 'coordinating') return handoff;
    if (!['launching', 'awaiting_readiness'].includes(handoff.state))
      return handoff;
    if (now() >= deadline)
      return {
        ...handoff,
        state: 'readiness_timeout',
        error:
          'verification handoff did not reach coordinating state before timeout',
      };
    await wait(Math.min(25, Math.max(1, deadline - now())));
  }
}

function awaitParentAcknowledgement({
  worker,
  timeoutMs = HANDOFF_READY_TIMEOUT_MS,
  receive = process,
} = {}) {
  if (typeof process.send !== 'function')
    return Promise.reject(new Error('verification worker IPC is unavailable'));
  return new Promise((resolveAcknowledged, rejectAcknowledged) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      receive.off?.('message', onMessage);
      receive.off?.('disconnect', onDisconnect);
      callback(value);
    };
    const onMessage = (message) => {
      if (
        message?.type === 'verification-submission-ack' &&
        message.workerNonce === worker.nonce
      )
        settle(resolveAcknowledged);
    };
    const onDisconnect = () =>
      settle(
        rejectAcknowledged,
        new Error('verification submitter disconnected before acknowledgment'),
      );
    const timer = setTimeout(
      () =>
        settle(
          rejectAcknowledged,
          new Error('verification submitter did not acknowledge readiness'),
        ),
      timeoutMs,
    );
    receive.on?.('message', onMessage);
    receive.once?.('disconnect', onDisconnect);
  });
}

/**
 * Start one detached coordinator worker after claiming an exact request handoff.
 * This returns acceptance only; terminal receipts remain the coordinator's sole
 * evidence surface.
 *
 * @param {{
 *   laneId: string,
 *   cwd?: string,
 *   root?: string,
 *   collectProvenance?: typeof collectVerificationProvenance,
 *   spawnWorker?: typeof spawn,
 *   readinessTimeoutMs?: number,
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<void>,
 *   maintenanceHooks?: Record<string, any>,
 *   identityProbe?: typeof currentWorkerIdentity,
 *   recoveryHooks?: Record<string, any>,
 * }} options
 *   `laneId` is required at runtime (the function throws unless it equals
 *   `CANONICAL_COMPLETION_LANE`) even though the destructuring gives it no
 *   default; `maintenanceHooks`/`recoveryHooks` are optional bags of
 *   test-injectable hooks consumed only via optional chaining (see
 *   `writeTerminalHandoffGCSummary` and `recoverCoordinatingHandoff`), so
 *   `Record<string, any>` states their real (loose) contract rather than
 *   inventing a narrower one. This annotation exists because
 *   tsconfig.scripts.json runs with checkJs:false, where tsc otherwise
 *   infers the parameter type from defaulted destructured properties only:
 *   `laneId`/`maintenanceHooks`/`recoveryHooks` have no default and silently
 *   vanish from the inferred shape, so a correct .ts call site that supplies
 *   them fails TS2353 (station#4109 review, second gap found).
 */
export async function submitVerification({
  laneId,
  cwd = process.cwd(),
  root = defaultCoordinatorRoot(),
  collectProvenance = collectVerificationProvenance,
  spawnWorker = spawn,
  readinessTimeoutMs = HANDOFF_READY_TIMEOUT_MS,
  now = Date.now,
  wait = sleep,
  maintenanceHooks,
  identityProbe = currentWorkerIdentity,
  recoveryHooks,
} = {}) {
  if (laneId !== CANONICAL_COMPLETION_LANE)
    throw new Error('verification submit accepts only full-regression');
  const toolchain = resolveVerificationToolchain({ cwd });
  const collectBoundProvenance = ({
    cwd: provenanceCwd = cwd,
    ...rest
  } = {}) => {
    assertVerificationToolchain(toolchain);
    return {
      ...collectProvenance({ ...rest, cwd: provenanceCwd }),
      toolchain: toolchain.toolchain,
      toolchainIdentity: toolchain.identity,
    };
  };
  const workerEnv = verificationExecutionEnvironment(toolchain);
  // Submission is a deliberate lifecycle mutation boundary. Status remains
  // observational; this best-effort bounded sweep cannot block a handoff.
  try {
    sweepTerminalSubmissionHandoffs({ root, now, gcHooks: maintenanceHooks });
  } catch {
    // Maintenance observability must not make an otherwise valid handoff fail.
  }
  const before = collectBoundProvenance({ cwd });
  // station#4109: same preflight as the synchronous coordinator path (see
  // `prepareCoordinatorContext`) -- refuse a stale install before a
  // handoff is even acquired, rather than spawning a detached worker that
  // will fail phases for reasons that have nothing to do with the branch.
  assertInstalledDependenciesMatchLockfile({ repositoryRoot: before.worktree });
  const request = createVerificationRequest(laneId, before);
  const retryDeadline = now() + readinessTimeoutMs;
  let acquired = acquireHandoff({ root, request, now });
  while (!acquired.acquired) {
    if (now() >= retryDeadline) {
      const current = readHandoff(acquired.directory);
      if (current?.state === 'coordinating') {
        const classification = classifyCoordinatingWorker(
          current.worker,
          identityProbe,
        );
        if (classification === 'live')
          return acceptedResult(current, acquired.directory, 'joined');
        if (classification !== 'recoverable')
          return {
            status: 'coordinating_identity_unavailable',
            evidence: false,
          };
        const recovered = recoverCoordinatingHandoff({
          directory: acquired.directory,
          request,
          now,
          identityProbe,
          recoveryHooks,
        });
        if (recovered.acquired) {
          acquired = recovered;
          break;
        }
        return {
          status: 'coordinating_identity_unavailable',
          evidence: false,
        };
      }
      return current?.request
        ? nonAcceptedResult(current, acquired.directory)
        : { status: 'handoff_unavailable', evidence: false };
    }
    if (acquired.retrying) {
      await wait(Math.min(25, Math.max(1, retryDeadline - now())));
      acquired = acquireHandoff({ root, request, now });
      continue;
    }
    if (acquired.handoff?.state === 'coordinating') {
      const recovered = recoverCoordinatingHandoff({
        directory: acquired.directory,
        request,
        now,
        identityProbe,
        recoveryHooks,
      });
      if (recovered.acquired) {
        acquired = recovered;
        break;
      } else if (recovered.live)
        return acceptedResult(acquired.handoff, acquired.directory, 'joined');
      else if (recovered.unavailable)
        return { status: 'coordinating_identity_unavailable', evidence: false };
      else {
        await wait(Math.min(25, Math.max(1, retryDeadline - now())));
        acquired = acquireHandoff({ root, request, now });
        continue;
      }
    }
    break;
  }
  if (!acquired.acquired) {
    const existing = await awaitHandoffState({
      directory: acquired.directory,
      timeoutMs: readinessTimeoutMs,
      now,
      wait,
    });
    return (existing.status ?? existing.state) === 'coordinating'
      ? acceptedResult(existing, acquired.directory, 'joined')
      : nonAcceptedResult(existing, acquired.directory);
  }

  let child;
  try {
    child = spawnWorker(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        '--worker',
        acquired.directory,
        launchTokenArgument(acquired.handoff.launchToken),
      ],
      {
        cwd: request.worktree,
        env: workerEnv,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    const ready = await awaitWorkerReadiness({
      child,
      timeoutMs: readinessTimeoutMs,
    });
    const handoff = coordinateReadyWorker(
      acquired.directory,
      ready.worker,
      now,
    );
    await acknowledgeWorker(child, ready.worker);
    child.disconnect?.();
    child.unref?.();
    return acceptedResult(handoff, acquired.directory, 'submitted');
  } catch (error) {
    failHandoff(acquired.directory, error, { now });
    child?.disconnect?.();
    child?.unref?.();
    // Do not signal a worker after a failed handshake. Its handoff state is the
    // fence: a late worker will observe this terminal launch failure and exit.
    throw error;
  }
}

export async function runSubmittedVerification({
  directory,
  launchToken,
  cwd = process.cwd(),
  collectProvenance = collectVerificationProvenance,
  coordinate = coordinateVerification,
  now = Date.now,
  send = process.send?.bind(process),
  awaitAcknowledgement = awaitParentAcknowledgement,
  workerIdentityFn = currentWorkerIdentity,
  platform = process.platform,
} = {}) {
  const handoff = readHandoff(directory);
  let worker;
  const reject = (error, state = 'failed_to_start') => {
    const failed = failHandoff(directory, error, {
      now,
      state,
      workerNonce: worker?.nonce,
      workerGeneration: handoff?.generation,
    });
    send?.({ type: 'verification-submission-failed', error: errorText(error) });
    return { state: failed?.state ?? state, error: errorText(error) };
  };
  if (!handoff?.request)
    return reject(new Error('verification handoff is unavailable'));
  if (
    !hasLaunchToken(handoff.launchToken) ||
    launchToken !== handoff.launchToken
  )
    return reject(new Error('verification worker launch token did not match'));
  if (!['launching', 'awaiting_readiness'].includes(handoff.state))
    return reject(
      new Error('verification handoff is not available for a worker'),
    );
  if (resolve(cwd) !== resolve(handoff.request.worktree))
    return reject(
      new Error('verification worker worktree does not match handoff'),
    );
  let actual;
  try {
    actual = createVerificationRequest(
      handoff.request.laneId,
      collectProvenance({ cwd }),
    );
  } catch (error) {
    return reject(error, 'stale_before_execution');
  }
  if (!sameRequest(actual, handoff.request))
    return reject(
      new Error('verification worktree changed before worker execution'),
      'stale_before_execution',
    );

  worker = {
    pid: process.pid,
    nonce: randomUUID(),
    startedAt: now(),
    launchToken,
    identity: workerIdentityFn(process.pid, launchToken),
  };
  try {
    if (typeof send !== 'function')
      throw new Error('verification worker IPC is unavailable');
    if (
      platform === 'darwin' &&
      worker.identity?.process?.token !== `launch:${launchToken}`
    )
      throw new Error(
        'verification worker launch token was not retained in process identity',
      );
    send({ type: 'verification-submission-ready', worker });
    await awaitAcknowledgement({ worker });
    const acknowledged = readHandoff(directory);
    if (
      acknowledged?.state !== 'coordinating' ||
      acknowledged.worker?.nonce !== worker.nonce
    )
      throw new Error(
        'verification handoff was not retained through acknowledgment',
      );
    const result = await coordinate({
      laneId: handoff.request.laneId,
      cwd,
      root: resolve(directory, '..', '..'),
      expectedRequest: handoff.request,
    });
    updateCoordinatingWorkerHandoff({
      directory,
      workerGeneration: handoff.generation,
      workerNonce: worker.nonce,
      update: {
        state: 'settled',
        receiptPath: canonicalReceiptPath(handoff.request),
        disposition: result.disposition,
        ...(result?.receipt?.terminal
          ? { terminal: result.receipt.terminal }
          : {}),
      },
      now,
    });
    return { state: 'settled', result };
  } catch (error) {
    return reject(
      error,
      String(error instanceof Error ? error.message : error).includes(
        'request changed',
      )
        ? 'stale_before_execution'
        : 'failed_to_start',
    );
  }
}

async function main() {
  const invocation = parseWorkerInvocation(process.argv.slice(2));
  if (!invocation)
    throw new Error(
      'verification submission worker requires a handoff directory',
    );
  const outcome = await runSubmittedVerification(invocation);
  if (outcome.state !== 'settled') process.exitCode = 2;
}

function parseWorkerInvocation(args) {
  const [command, directory, tokenArgument] = args;
  const launchToken = tokenArgument?.slice(
    '--verification-launch-token='.length,
  );
  if (
    args.length !== 3 ||
    command !== '--worker' ||
    !directory ||
    tokenArgument !== launchTokenArgument(launchToken) ||
    !hasLaunchToken(launchToken)
  )
    return null;
  return { directory, launchToken };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(errorText(error));
    process.exitCode = 2;
  });

export const __verificationSubmissionInternals = {
  acquireRetryClaim,
  acquireHandoff,
  awaitHandoffState,
  coordinateReadyWorker,
  failHandoff,
  handoffDirectory,
  isRetryableRejectedHandoff,
  readHandoff,
  releaseRetryClaim,
  retryClaimDirectory,
  retryRejectedHandoff,
  parseWorkerInvocation,
  launchTokenArgument,
  recoverCoordinatingHandoff,
  sameRequest,
  sweepTerminalSubmissionHandoffs,
  updateHandoff,
  updateCoordinatingWorkerHandoff,
  writeJsonAtomic,
};
