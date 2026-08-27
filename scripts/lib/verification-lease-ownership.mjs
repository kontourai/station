import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { probeExactProcessIdentity } from '../../packages/shared/src/process-identity.mjs';
import { CANONICAL_COMPLETION_LANE } from '../verification-lanes.mjs';
import { HOST_PRESSURE_GATE_WEIGHT } from './verification-host-pressure.mjs';
import {
  readJson,
  readJsonRecord,
  requireDirectoryEntries,
  writeJsonAtomic,
} from './verification-lease-store.mjs';
import { jobDirectory } from './verification-request-identity.mjs';

export const STALE_MS = 15_000;
export const FULL_WEIGHT_CI_FAST_BYPASS_MS = 30_000;
const MUTATION_CLAIM_WAIT_ATTEMPTS = 25;
const MUTATION_CLAIM_WAIT_MS = 10;
export const CAPACITY_CONSUMING_STATES = new Set([
  'admitted',
  'output',
  'running',
  'canceling',
]);
const FINISHED_LEASE_TTL_MS = 5 * 60_000;
const FINISHED_LEASE_MAX = 32;
const REQUEST_DIRECTORY_KEY =
  /^[0-9a-f]{64}(?:\.force-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receiptCommitPath(path) {
  return `${path}.commit.json`;
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows does not implement POSIX modes.
  }
}

function assertLeaseOwner(directory, owner) {
  const current = readJson(join(directory, 'lease.json'));
  return current?.owner?.nonce === owner?.nonce;
}

// Win32 reports a rename onto an occupied directory as EPERM rather than the
// EEXIST/ENOTEMPTY pair returned by POSIX hosts. Only classify EPERM as normal
// contention when the exact destination now exists; a real permission error
// against an absent target must still surface.
function isOccupiedRename(error, destination) {
  return (
    error?.code === 'EEXIST' ||
    error?.code === 'ENOTEMPTY' ||
    (error?.code === 'EPERM' && existsSync(destination))
  );
}

function renameDirectoryWithRetry(source, destination) {
  const attempts = process.platform === 'win32' ? 9 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (error?.code !== 'EPERM' || attempt === attempts - 1) throw error;
      // Windows indexing/AV can retain a just-closed directory handle for a
      // few milliseconds. Retry the exact rename; never copy or delete around
      // it because the rename is the ownership publication boundary.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
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

/** A fresh heartbeat is never enough to steal a lease; PID identity must agree. */
export function leaseIsLive(
  lease,
  {
    now = Date.now(),
    processIdentityFn = processIdentity,
    staleMs = STALE_MS,
  } = {},
) {
  if (!lease?.owner || !Number.isFinite(lease.heartbeatAt)) return false;
  const actual = processIdentityFn(lease.owner.pid);
  if (!actual) return false;
  // A live Windows PID without a bounded round-trip UTC CIM CreationDate is
  // not evidence of death. Retain its lease rather than reclaiming an owner
  // whose PID could have been recycled while unavailable.
  if (actual.unavailable) return true;
  if (lease.owner.processStart) {
    // Identity is provable: this either IS the owner, or the PID was recycled.
    // A proven owner retains its lease even after a missed heartbeat, which
    // avoids reclaiming a process paused under a debugger or heavy host
    // contention — the case the previous comment was defending.
    return actual.start === lease.owner.processStart;
  }
  // station#3187: `processStart` is `identity?.start ?? null` at lease
  // creation, so it can be absent — and the reuse check above was skipped
  // entirely when it was. The old tail then read
  // `now - heartbeatAt <= staleMs || Boolean(actual)`, and `actual` is already
  // proven truthy above, so that `||` was ALWAYS true: the staleness check was
  // dead code and a bare PID granted liveness forever. A 60-unit lease with no
  // process behind it reported `running, live: true` while four real jobs
  // queued behind it.
  //
  // An unverifiable identity is not proof of ownership, so it does not get the
  // unbounded grant a proven one does — it falls back to the heartbeat.
  return now - lease.heartbeatAt <= staleMs;
}

function isLeaseStale(lease, options) {
  return !leaseIsLive(lease, options);
}

function createOwner() {
  const identity = processIdentity(process.pid);
  if (identity?.unavailable)
    throw new Error(
      'verification coordinator cannot create a lease while its round-trip UTC Windows CreationDate is unavailable',
    );
  return {
    pid: process.pid,
    processStart: identity?.start ?? null,
    nonce: randomUUID(),
  };
}

function statusForDirectory(directory, options) {
  const lease = readJson(join(directory, 'lease.json'));
  if (!lease) return null;
  // Completed pointers are inspectable metadata, not capacity owners.  Do not
  // probe their PID: the owner may have exited and the PID may have been
  // recycled, neither of which changes the completed receipt.
  if (isSettledLease(lease))
    return { ...lease, state: 'finished', live: false };
  return { ...lease, live: leaseIsLive(lease, options) };
}

function listJobs(root, options) {
  const requests = join(root, 'requests');
  if (!existsSync(requests)) return [];
  return Object.entries(readDirectory(requests)).flatMap(
    ([name, _directory]) => {
      if (!REQUEST_DIRECTORY_KEY.test(name)) return [];
      const status = statusForDirectory(join(requests, name), options);
      return status ? [{ key: name, ...status }] : [];
    },
  );
}

function readDirectory(path) {
  try {
    return Object.fromEntries(
      requireDirectoryEntries(path).map((name) => [name, true]),
    );
  } catch {
    return {};
  }
}

function activeWeight(root, ownKey, options) {
  return listJobs(root, options)
    .filter(
      (job) =>
        job.key !== ownKey &&
        job.live &&
        CAPACITY_CONSUMING_STATES.has(job.state),
    )
    .reduce((sum, job) => sum + job.weight, 0);
}

/**
 * The completion gate has a separate host-wide owner from request-key reuse.
 * Different worktrees legitimately have different receipt identities, but
 * they must not execute canonical completion phases concurrently on one host.
 * FIFO is the explicit freshness policy when no branch/PR relation is known.
 */
function completionQueueEligible(root, ownKey, options) {
  const waiters = listJobs(root, options)
    .filter(
      (job) =>
        job.live &&
        job.state === 'queued' &&
        job.request?.laneId === CANONICAL_COMPLETION_LANE,
    )
    .sort(
      (left, right) =>
        (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
        String(left.key).localeCompare(String(right.key)),
    );
  return waiters.length === 0 || waiters[0].key === ownKey;
}

function completionWaiterCount(root, ownKey, options) {
  return listJobs(root, options).filter(
    (job) =>
      job.key !== ownKey &&
      job.live &&
      job.state === 'queued' &&
      job.completionQueueReserved === true &&
      job.request?.laneId === CANONICAL_COMPLETION_LANE,
  ).length;
}

function cleanStaleCompletionJobs(root, options) {
  for (const job of listJobs(root, options)) {
    if (
      job.request?.laneId !== CANONICAL_COMPLETION_LANE ||
      job.live ||
      isSettledLease(job)
    )
      continue;
    cleanStaleDirectory(jobDirectory(root, job.key), options);
  }
}

/**
 * FIFO eligibility for host-pressure admission: no other live queued gated lane
 * may be strictly ahead of this lane in (createdAt, key) order. This prevents a
 * later-arriving heavy lane from jumping an earlier one still queued behind
 * pressure. Self is always eligible when no contender precedes it.
 */
function hostPressureFifoBlocker(root, ownKey, ownLease, options) {
  const ownCreatedAt = ownLease?.createdAt;
  if (!Number.isFinite(ownCreatedAt)) return null;
  for (const job of listJobs(root, options)) {
    if (job.key === ownKey) continue;
    if (!job.live || job.state !== 'queued') continue;
    // A lane yielding to this request through full-capacity fairness cannot
    // also precede it in the pressure FIFO. Binding both edges creates a
    // cycle in which neither request admits on an otherwise idle host.
    if (
      job.queueReason === 'full_weight_fairness' &&
      job.blockingRequestKey === ownKey
    )
      continue;
    if (!Number.isFinite(job.weight) || job.weight < HOST_PRESSURE_GATE_WEIGHT)
      continue;
    if (!Number.isFinite(job.createdAt)) continue;
    if (job.createdAt < ownCreatedAt) return job;
    if (job.createdAt === ownCreatedAt && String(job.key) < String(ownKey))
      return job;
  }
  return null;
}

function hostPressureFifoEligible(root, ownKey, ownLease, options) {
  return !hostPressureFifoBlocker(root, ownKey, ownLease, options);
}

/**
 * A full-capacity lane cannot make progress until every active lane drains.
 * Once one is queued, admitting more ordinary work into newly available space
 * can postpone it forever. Keep the oldest such request eligible and reserve
 * the remaining headroom for ci:fast only: fast feedback is intentionally the
 * bounded 20-unit overlap path, while every other lane yields to the waiter.
 */
function fullWeightQueueBlocker(root, ownKey, lane, capacity, options) {
  const waiters = listJobs(root, options)
    .filter(
      (job) => job.live && job.state === 'queued' && job.weight === capacity,
    )
    .sort(
      (left, right) =>
        (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
        String(left.key).localeCompare(String(right.key)),
    );
  const earliest = waiters[0];
  if (!earliest) return null;
  if (lane.id === 'ci-fast') {
    // One bounded feedback overlap remains useful when completion work first
    // queues. Once the full-capacity request has waited this long, new fast
    // arrivals must yield; otherwise an unbounded stream of five-minute fast
    // lanes can prevent the 100-unit lane from ever draining the host.
    const bypassAllowed =
      !Number.isFinite(earliest.createdAt) ||
      options.now - earliest.createdAt < FULL_WEIGHT_CI_FAST_BYPASS_MS;
    return bypassAllowed ? null : earliest;
  }
  return earliest.key === ownKey ? null : earliest;
}

function fullWeightQueueEligible(root, ownKey, lane, capacity, options) {
  return !fullWeightQueueBlocker(root, ownKey, lane, capacity, options);
}

/** Directory creation and owner publication are one operation to readers. */
function acquireLeaseDirectory(path, lease) {
  // A bare mkdir followed by writing lease.json exposes an empty directory to
  // other callers if the owner crashes between the two operations.  Stage a
  // fully initialized lease beside the target and publish it with one rename.
  ensureDirectory(resolve(path, '..'));
  const staged = `${path}.claim-${randomUUID()}`;
  try {
    mkdirSync(staged, { recursive: false, mode: 0o700 });
    writeLease(staged, lease);
    renameDirectoryWithRetry(staged, path);
    return true;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (isOccupiedRename(error, path)) return false;
    throw error;
  }
}

function sameRemovalOwner(left, right) {
  return (
    Number.isInteger(left?.pid) &&
    left.pid > 0 &&
    left.pid === right?.pid &&
    left.processStart === right?.processStart &&
    typeof left.nonce === 'string' &&
    left.nonce.length > 0 &&
    left.nonce === right?.nonce
  );
}

function acquireOwnedMutationClaim(directory, owner, options) {
  for (let attempt = 0; attempt < MUTATION_CLAIM_WAIT_ATTEMPTS; attempt += 1) {
    const claim = acquireMutationClaim(directory, owner, options);
    if (claim) return claim;
    if (attempt < MUTATION_CLAIM_WAIT_ATTEMPTS - 1)
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        MUTATION_CLAIM_WAIT_MS,
      );
  }
  return null;
}

function sameDirectoryIdentity(before, after) {
  if (!before?.isDirectory?.() || !after?.isDirectory?.()) return false;
  // dev/ino are unavailable on some Windows filesystems. In that case the
  // exact post-move owner records below remain the conservative fallback.
  if (!Number.isFinite(before.dev) || !Number.isFinite(before.ino)) return true;
  if (!Number.isFinite(after.dev) || !Number.isFinite(after.ino)) return true;
  return before.dev === after.dev && before.ino === after.ino;
}

/**
 * Owns the complete release protocol. The boolean wrapper remains the caller
 * Interface; its private outcome preserves whether capacity was released even
 * when the unreachable old inode retained cleanup residue.
 */
function createOwnedDirectoryRemover({
  removeDirectory = rmSync,
  acquireMutation = acquireOwnedMutationClaim,
  releaseMutation = releaseMutationClaim,
  renameDirectory = renameDirectoryWithRetry,
  statDirectory = lstatSync,
  readJsonFile = readJson,
} = {}) {
  return function removeOwnedDirectoryOutcome(path, owner) {
    let initial;
    try {
      initial = readJsonFile(join(path, 'lease.json'));
    } catch (error) {
      return { kind: 'indeterminate', error };
    }
    if (!sameRemovalOwner(initial?.owner, owner)) return { kind: 'not-owner' };

    let mutation;
    try {
      mutation = acquireMutation(path, owner);
    } catch (error) {
      return { kind: 'indeterminate', error };
    }
    if (!mutation) return { kind: 'blocked' };
    let quarantine = null;
    let moved = false;
    try {
      let beforeMove;
      let beforeIdentity;
      try {
        beforeMove = readJsonFile(join(path, 'lease.json'));
        beforeIdentity = statDirectory(path);
      } catch (error) {
        return { kind: 'indeterminate', error };
      }
      if (!sameRemovalOwner(beforeMove?.owner, owner))
        return { kind: 'not-owner' };
      // Same-parent rename keeps the move atomic without a mutable cleanup
      // root. A residue suffix is not accepted by request discovery.
      quarantine = `${path}.remove-${randomUUID()}`;
      try {
        renameDirectory(path, quarantine);
        moved = true;
      } catch (error) {
        if (error?.code === 'ENOENT' || isOccupiedRename(error, quarantine))
          return { kind: 'not-released' };
        return { kind: 'indeterminate', error };
      }

      // This inode is never reused. Validate the exact lease and mutation
      // owner after the move before any recursive cleanup can touch it.
      let inode;
      let movedLease;
      let movedMutation;
      try {
        inode = statDirectory(quarantine);
        movedLease = readJsonFile(join(quarantine, 'lease.json'));
        movedMutation = readJsonFile(
          join(quarantine, '.mutation', 'owner.json'),
        );
      } catch (error) {
        return { kind: 'indeterminate', error };
      }
      if (
        !sameRemovalOwner(movedLease?.owner, owner) ||
        !sameRemovalOwner(movedMutation, owner) ||
        !sameDirectoryIdentity(beforeIdentity, inode)
      ) {
        if (!existsSync(path)) {
          try {
            renameDirectory(quarantine, path);
            quarantine = null;
            moved = false;
            return { kind: 'not-released' };
          } catch (error) {
            return { kind: 'indeterminate', error };
          }
        }
        return { kind: 'indeterminate' };
      }
    } finally {
      // A failed/uncertain outer rename leaves the canonical claim at `path`.
      // Always release that claim so the next caller can retry; a successful
      // move carries it into the private quarantine and owns it there.
      if (!moved) {
        try {
          releaseMutation(mutation, owner);
        } catch {
          // The total outcome above remains authoritative; callers never
          // infer canonical ownership from a cleanup exception.
        }
      }
    }

    try {
      removeDirectory(quarantine, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 10,
      });
      return { kind: 'released' };
    } catch (error) {
      // The canonical name was released by the atomic rename. Never retry it:
      // a successor may already own that path. The unique residue is safe.
      return { kind: 'released-with-residue', quarantine, error };
    }
  };
}

const removeOwnedDirectoryOutcome = createOwnedDirectoryRemover();

function removeOwnedDirectory(path, owner) {
  const outcome = removeOwnedDirectoryOutcome(path, owner);
  return (
    outcome.kind === 'released' || outcome.kind === 'released-with-residue'
  );
}

function groupIsLive(pgid) {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid < 1)
    return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function recoverExactChild(
  child,
  {
    platform = process.platform,
    processIdentityFn = processIdentity,
    groupIsLiveFn = groupIsLive,
  } = {},
) {
  // A missing child record means this lease never spawned a tree. Any present
  // but incomplete record is unsafe recovery metadata and stays fenced.
  if (!child) return true;
  if (!Number.isInteger(child.pid) || child.pid < 1) return false;
  const exact = processIdentityFn(child.pid);
  if (platform === 'win32') {
    // Only the new Job-bound child protocol makes absence/mismatch a bounded
    // settlement signal. A live-but-unverifiable PID remains fenced, and a
    // recycled PID is never signalled by recovery.
    if (
      child.jobBound !== true ||
      typeof child.processStart !== 'string' ||
      !child.processStart ||
      !Number.isInteger(child.guard?.pid) ||
      child.guard.pid < 1 ||
      typeof child.guard?.processStart !== 'string' ||
      !child.guard.processStart
    )
      return false;
    const settled = (identity, expected) => {
      if (identity?.unavailable) return false;
      return !identity || identity.start !== expected;
    };
    const guard = processIdentityFn(child.guard.pid);
    // Recheck after a bounded settle interval: only both exact identities
    // absent/recycled permit advancing a stale owner, never a live PID.
    if (
      !settled(exact, child.processStart) ||
      !settled(guard, child.guard.processStart)
    )
      return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    return (
      settled(processIdentityFn(child.pid), child.processStart) &&
      settled(processIdentityFn(child.guard.pid), child.guard.processStart)
    );
  }
  if (exact && child.processStart && exact.start !== child.processStart)
    return false;
  const pgid = child.pgid ?? child.pid;
  if (!groupIsLiveFn(pgid)) return true;
  for (const signal of ['TERM', 'KILL']) {
    try {
      process.kill(-pgid, `SIG${signal}`);
    } catch {
      // The group can exit between probe and signal; the post-signal probe is
      // authoritative.
    }
    // Give init/the parent a bounded chance to reap a just-killed descendant;
    // a live-looking zombie is not safe to reclaim until it disappears.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!groupIsLiveFn(pgid)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return false;
}

function recoverMutationClaim(directory, options = {}) {
  const lock = join(directory, '.mutation');
  const claimedRecord = readJsonRecord(join(lock, 'owner.json'));
  const claimed = claimedRecord.value;
  // A corrupt claim record proves no live owner (nothing can assert a nonce
  // against it), so it is reclaimable like a stale one; leaving it in place
  // would block this directory's mutations until manual cleanup (#3287).
  if (
    !claimedRecord.corrupt &&
    (!claimed ||
      leaseIsLive(
        { owner: claimed, heartbeatAt: claimed.heartbeatAt },
        options,
      ))
  )
    return false;
  const quarantine = `${lock}.reclaim-${claimed?.nonce ?? 'corrupt'}-${randomUUID()}`;
  try {
    renameDirectoryWithRetry(lock, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }
  const currentRecord = readJsonRecord(join(quarantine, 'owner.json'));
  const current = currentRecord.value;
  const sameDeadClaim = claimedRecord.corrupt
    ? currentRecord.corrupt
    : current?.nonce === claimed.nonce &&
      !leaseIsLive(
        { owner: current, heartbeatAt: current.heartbeatAt },
        options,
      );
  if (!sameDeadClaim) {
    try {
      renameDirectoryWithRetry(quarantine, lock);
    } catch {
      // A newer claimant owns the canonical lock name.
    }
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function acquireMutationClaim(directory, owner, options) {
  const lock = join(directory, '.mutation');
  const staged = `${lock}.${randomUUID()}.claim`;
  try {
    mkdirSync(staged, { recursive: false, mode: 0o700 });
    writeJsonAtomic(join(staged, 'owner.json'), {
      ...owner,
      heartbeatAt: Date.now(),
    });
    renameDirectoryWithRetry(staged, lock);
    return lock;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (isOccupiedRename(error, lock)) {
      if (recoverMutationClaim(directory, options))
        return acquireMutationClaim(directory, owner, options);
      return null;
    }
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function releaseMutationClaim(lock, owner) {
  const claimed = readJson(join(lock, 'owner.json'));
  if (claimed?.nonce !== owner?.nonce) return false;
  rmSync(lock, { recursive: true, force: true });
  return true;
}

/**
 * A corrupt lease can prove neither ownership nor liveness, so nothing can
 * ever heartbeat it back to health — without reclamation the request key is
 * blocked until manual cleanup. Its owner (if still alive) self-fences on its
 * next heartbeat: `writeOwnedLease` cannot assert a nonce against an
 * unparseable file. Quarantine-then-remove under the same mutation claim and
 * atomic outer rename the stale path uses.
 */
function cleanCorruptLeaseDirectory(path, leasePath, options) {
  const reaper = options?.reaper ?? createOwner();
  const mutation = acquireMutationClaim(path, reaper, options);
  if (!mutation) return false;
  if (!readJsonRecord(leasePath).corrupt) {
    // Re-read under the claim: only a still-unparseable lease is reclaimable.
    releaseMutationClaim(mutation, reaper);
    return false;
  }
  const quarantine = `${path}.corrupt-${randomUUID()}`;
  try {
    renameDirectoryWithRetry(path, quarantine);
  } catch (error) {
    releaseMutationClaim(mutation, reaper);
    if (error?.code === 'ENOENT' || isOccupiedRename(error, quarantine))
      return false;
    throw error;
  }
  if (!readJsonRecord(join(quarantine, 'lease.json')).corrupt) {
    // The canonical name held something parseable by the time it moved;
    // restore it rather than deleting a healthy successor.
    let restored = false;
    try {
      renameDirectoryWithRetry(quarantine, path);
      restored = true;
    } catch {
      // A successor owns the canonical name; retain the suspect quarantine.
    }
    if (restored) releaseMutationClaim(mutation, reaper);
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function cleanStaleDirectory(path, options) {
  const record = readJsonRecord(join(path, 'lease.json'));
  if (record.corrupt)
    return cleanCorruptLeaseDirectory(path, join(path, 'lease.json'), options);
  const lease = record.value;
  if (!lease || !isLeaseStale(lease, options)) return false;
  // The mutation claim belongs to the live REAPER, never the stale lease
  // owner. Publishing the dead identity makes another reaper immediately
  // eligible to steal this lock while exact-child recovery is still active.
  const reaper = options?.reaper ?? createOwner();
  const mutation = acquireMutationClaim(path, reaper, options);
  if (!mutation) return false;
  // The claim serializes heartbeat mutation with recovery. Keep the canonical
  // directory occupied while exact child recovery runs: a fresh owner must
  // never acquire beside a descendant that still owns this lease's outputs.
  const current = readJson(join(path, 'lease.json'));
  if (
    current?.owner?.nonce !== lease.owner?.nonce ||
    !isLeaseStale(current, options)
  ) {
    releaseMutationClaim(mutation, reaper);
    return false;
  }
  if (!(options.recoverExactChildFn ?? recoverExactChild)(current.child)) {
    const fenced = {
      ...current,
      state: 'fenced',
      recoveryPending: true,
    };
    writeLease(path, fenced);
    releaseMutationClaim(mutation, reaper);
    return false;
  }
  const final = readJson(join(path, 'lease.json'));
  if (final?.owner?.nonce !== lease.owner?.nonce) {
    releaseMutationClaim(mutation, reaper);
    return false;
  }
  // Publish the stale directory's removal by an atomic outer rename. A fresh
  // scheduler owner can acquire the canonical path immediately, while the
  // old directory (and its claim) is deleted only through its quarantined
  // identity. This prevents a delayed recursive rm from deleting a successor
  // or racing its mkdir with ENOTEMPTY.
  const quarantine = `${path}.stale-${final.owner.nonce}-${randomUUID()}`;
  try {
    renameDirectoryWithRetry(path, quarantine);
  } catch (error) {
    releaseMutationClaim(mutation, reaper);
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }
  const quarantined = readJson(join(quarantine, 'lease.json'));
  if (quarantined?.owner?.nonce !== final.owner.nonce) {
    let restored = false;
    try {
      renameDirectoryWithRetry(quarantine, path);
      restored = true;
    } catch {
      // A successor owns the canonical name; retain the suspect quarantine.
    }
    if (restored) releaseMutationClaim(mutation, reaper);
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function writeLease(directory, lease) {
  writeJsonAtomic(join(directory, 'lease.json'), lease);
}

function writeTransactionLease({ directory, lease, phase, terminalHooks }) {
  terminalHooks?.beforeLeaseWrite?.({ directory, lease, phase });
  writeLease(directory, lease);
}

function writeOwnedLease(directory, owner, lease) {
  const mutation = acquireMutationClaim(directory, owner);
  if (!mutation) return false;
  try {
    if (!assertLeaseOwner(directory, owner)) return false;
    writeLease(directory, lease);
    return assertLeaseOwner(directory, owner);
  } finally {
    releaseMutationClaim(mutation, owner);
  }
}

function markOwnedLeaseLost(
  directory,
  owner,
  now,
  { reclaimable = false } = {},
) {
  const current = readJson(join(directory, 'lease.json'));
  if (current?.owner?.nonce !== owner?.nonce) return false;
  return writeOwnedLease(directory, owner, {
    ...current,
    state: 'ownership_lost',
    heartbeatAt: now(),
    ownershipLostAt: now(),
    ...(reclaimable ? { reclaimable: true } : {}),
  });
}

function reclaimTerminalOwnershipLoss(directory) {
  const lease = readJson(join(directory, 'lease.json'));
  if (lease?.state !== 'ownership_lost' || lease.reclaimable !== true)
    return false;
  return removeOwnedDirectory(directory, lease.owner);
}

function recordOwnershipLoss(root, directory, owner, now) {
  const losses = join(root, 'ownership-loss');
  ensureDirectory(losses);
  writeJsonAtomic(join(losses, `${hash(`${directory}:${owner.nonce}`)}.json`), {
    owner,
    directory,
    state: 'ownership_lost',
    recordedAt: now(),
  });
}

/**
 * station#3287: ownership loss is a cleanup path, and on a full disk every
 * one of its lease writes throws ENOSPC — unprotected, that escaped a
 * heartbeat `setInterval` as an uncaught crash with no terminal record.
 * Best-effort by contract: the caller has already stopped heartbeating, so
 * even an unrecorded loss goes stale within `STALE_MS` and successors
 * reclaim it via exact PID identity. Never throws; failures are named once
 * each on stderr.
 */
function markOwnershipLostBestEffort({
  root,
  directory,
  owner,
  now,
  reclaimable = false,
  completionLock = null,
  outputLock = null,
  warn = console.warn,
}) {
  const lost = (target) => () =>
    markOwnedLeaseLost(target, owner, now, { reclaimable });
  const writes = [
    [
      'ownership-loss record',
      () => recordOwnershipLoss(root, directory, owner, now),
    ],
    ['request lease', lost(directory)],
  ];
  if (completionLock) writes.push(['completion lease', lost(completionLock)]);
  if (outputLock) writes.push(['output lease', lost(outputLock)]);
  let recorded = true;
  for (const [label, write] of writes) {
    try {
      write();
    } catch (error) {
      recorded = false;
      warn(
        `verification coordinator could not record ownership loss (${label}); ` +
          `the stale lease is reclaimed by the next run: ${error?.message ?? error}`,
      );
    }
  }
  return recorded;
}

function withOwnedLeaseMutation({ directory, outputLock, owner, mutate }) {
  const requestMutation = acquireMutationClaim(directory, owner);
  if (!requestMutation) return false;
  const outputMutation = acquireMutationClaim(outputLock, owner);
  if (!outputMutation) {
    releaseMutationClaim(requestMutation, owner);
    return false;
  }
  try {
    const requestLease = readJson(join(directory, 'lease.json'));
    const outputLease = readJson(join(outputLock, 'lease.json'));
    if (
      requestLease?.owner?.nonce !== owner?.nonce ||
      outputLease?.owner?.nonce !== owner?.nonce
    )
      return false;
    return mutate({ requestLease, outputLease });
  } finally {
    releaseMutationClaim(outputMutation, owner);
    releaseMutationClaim(requestMutation, owner);
  }
}

function ownOutput(directory, lease, options) {
  if (reclaimTerminalOwnershipLoss(directory))
    return ownOutput(directory, lease, options);
  if (acquireLeaseDirectory(directory, lease)) return true;
  if (
    cleanStaleDirectory(directory, options) &&
    acquireLeaseDirectory(directory, lease)
  )
    return true;
  return false;
}

function isSettledLease(lease) {
  return (
    lease?.state === 'finished' ||
    (lease?.state === 'commit_pending' &&
      typeof lease.receiptPath === 'string' &&
      existsSync(receiptCommitPath(lease.receiptPath)))
  );
}

function gcFinishedLeases(root, { now = Date.now() } = {}) {
  const requests = join(root, 'requests');
  const finished = requireDirectoryEntries(requests)
    .filter((name) => REQUEST_DIRECTORY_KEY.test(name))
    .map((name) => ({
      name,
      directory: join(requests, name),
      lease: readJson(join(requests, name, 'lease.json')),
    }))
    .filter(({ lease }) => isSettledLease(lease))
    .sort(
      (left, right) =>
        (left.lease.finishedAt ?? left.lease.heartbeatAt ?? 0) -
        (right.lease.finishedAt ?? right.lease.heartbeatAt ?? 0),
    );
  const excess = Math.max(0, finished.length - FINISHED_LEASE_MAX);
  const reaper = createOwner();
  for (let index = 0; index < finished.length; index += 1) {
    const entry = finished[index];
    const age =
      now - (entry.lease.finishedAt ?? entry.lease.heartbeatAt ?? now);
    if (index >= excess && age <= FINISHED_LEASE_TTL_MS) continue;
    // A finished lease is immutable metadata, not a live ownership claim.
    // GC intentionally never probes a PID here: a recycled PID cannot make a
    // terminal pointer immortal, and active/fenced/output states are excluded.
    const mutation = acquireMutationClaim(entry.directory, reaper);
    if (!mutation) continue;
    const current = readJson(join(entry.directory, 'lease.json'));
    if (
      !isSettledLease(current) ||
      current.owner?.nonce !== entry.lease.owner?.nonce
    ) {
      releaseMutationClaim(mutation, reaper);
      continue;
    }
    const quarantine = `${entry.directory}.gc-${current.owner.nonce}-${randomUUID()}`;
    try {
      renameDirectoryWithRetry(entry.directory, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // A replacement owns the target; leave it untouched.
      releaseMutationClaim(mutation, reaper);
    }
  }
}

export const verificationLeaseOwnership = Object.freeze({
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
  fullWeightQueueEligible,
  gcFinishedLeases,
  hostPressureFifoBlocker,
  hostPressureFifoEligible,
  isSettledLease,
  listJobs,
  markOwnedLeaseLost,
  markOwnershipLostBestEffort,
  ownOutput,
  processIdentity,
  readJson,
  reclaimTerminalOwnershipLoss,
  recordOwnershipLoss,
  recoverExactChild,
  recoverMutationClaim,
  releaseMutationClaim,
  removeOwnedDirectory,
  removeOwnedDirectoryOutcome,
  requireDirectoryEntries,
  statusForDirectory,
  withOwnedLeaseMutation,
  writeJsonAtomic,
  writeOwnedLease,
  writeTransactionLease,
});
