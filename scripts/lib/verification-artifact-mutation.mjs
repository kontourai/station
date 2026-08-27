import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { probeExactProcessIdentity } from '../../packages/shared/src/process-identity.mjs';

const REQUEST_KEY = /^[0-9a-f]{64}$/;
const MUTATION_DIRECTORY = 'artifact-mutations';

function assertRequestKey(requestKey) {
  if (!REQUEST_KEY.test(requestKey ?? ''))
    throw new Error(
      'artifact mutation requires a lowercase sha256 request key',
    );
}

function readClaim(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'claim.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIdentity(pid) {
  const probe = probeExactProcessIdentity(pid);
  return probe.state === 'exact'
    ? probe.identity
    : probe.state === 'unavailable'
      ? { pid, start: null, unavailable: true }
      : null;
}

function claimIsLive(claim) {
  const actual = processIdentity(claim?.owner?.pid);
  return Boolean(
    actual &&
      (actual.unavailable ||
        !claim.owner.processStart ||
        actual.start === claim.owner.processStart),
  );
}

function reclaimDeadClaim(target, expected) {
  const quarantine = `${target}.reclaim-${expected?.owner?.nonce ?? 'invalid'}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
  } catch {
    return false;
  }
  const current = readClaim(quarantine);
  if (
    current?.owner?.nonce === expected?.owner?.nonce &&
    !claimIsLive(current)
  ) {
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  }
  if (!existsSync(target)) {
    try {
      renameSync(quarantine, target);
    } catch {}
  }
  return false;
}

/**
 * Publishes an initialized request-key fence with one directory rename. The
 * coordinator and explicit artifact GC both use this exact path, so neither
 * may write or remove a request's workspace artifacts while the other owns it.
 */
export function tryAcquireVerificationArtifactMutation({
  root,
  requestKey,
  now = Date.now(),
  hooks,
} = {}) {
  assertRequestKey(requestKey);
  const directory = resolve(root, MUTATION_DIRECTORY);
  const target = resolve(directory, requestKey);
  const identity = processIdentity(process.pid);
  if (identity?.unavailable) return null;
  const claim = {
    owner: {
      pid: process.pid,
      processStart: identity?.start ?? null,
      nonce: randomUUID(),
    },
    createdAt: now,
    heartbeatAt: now,
  };
  const staged = `${target}.claim-${claim.owner.nonce}`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    writeFileSync(join(staged, 'claim.json'), `${JSON.stringify(claim)}\n`, {
      mode: 0o600,
    });
    hooks?.afterStage?.({ staged, target, claim });
    renameSync(staged, target);
    return { directory: target, claim };
  } catch {
    try {
      rmSync(staged, { recursive: true, force: true });
    } catch {
      // A contention/error is non-actionable; never disturb the owner.
    }
    const existing = readClaim(target);
    if (
      existing &&
      !claimIsLive(existing) &&
      reclaimDeadClaim(target, existing)
    )
      return tryAcquireVerificationArtifactMutation({ root, requestKey, now });
    return null;
  }
}

export function releaseVerificationArtifactMutation(mutation) {
  if (!mutation) return false;
  try {
    if (
      readClaim(mutation.directory)?.owner?.nonce !==
      mutation.claim?.owner?.nonce
    )
      return false;
    rmSync(mutation.directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function verificationArtifactMutationIsHeld({ root, requestKey } = {}) {
  assertRequestKey(requestKey);
  return existsSync(resolve(root, MUTATION_DIRECTORY, requestKey));
}
