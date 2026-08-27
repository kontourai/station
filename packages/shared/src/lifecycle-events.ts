import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleepAsync } from 'node:timers/promises';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import {
  lookupProcessBirthFingerprint,
  lookupProcessBirthFingerprintCached,
  lookupProcessBirthFingerprintCachedAsync,
  PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
} from './process-identity.mjs';

export const LIFECYCLE_EVENT_VERSION = 1 as const;
export const DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES = 10 * 1024 * 1024;
// 1.5s (was 1s): under heavy host load `ps` can miss a short deadline for a
// perfectly healthy pid, and a spurious null fails the lifecycle lock closed
// (#1057). Kept deliberately small because these lookups run synchronously on
// the main thread — including inside the lock's reclaim loop, which performs
// several per acquisition — so resilience comes from the bounded RETRY at the
// two own-pid acquisition entry points, not from a long single deadline.
export { PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS };

export type LifecycleIdentity = {
  instanceId: string;
  sha: string;
  bootId: string;
  pid: number;
};

export type StopIntent =
  | 'promotion'
  | 'operator_stop'
  | 'recovery'
  | 'rollback';

export type LifecycleEvent = LifecycleIdentity & {
  version: 1;
  eventId?: string;
  timestamp: string;
  type:
    | 'started'
    | 'stop_intent'
    | 'stop_result'
    | 'shutdown_observed'
    | 'process_exit';
  intent?: StopIntent;
  operationId?: string;
  expiresAt?: string;
  result?: 'completed' | 'already_absent' | 'failed';
  reason?: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'startup_failure';
  exitCode?: number | null;
  signal?: string | null;
  sender?: 'unknown';
};

export type ExitClassification =
  | 'expected_promotion'
  | 'operator_stop'
  | 'expected_recovery_stop'
  | 'expected_rollback'
  | 'unexpected_signal'
  | 'crash'
  | 'crash_unobserved';

function validateIdentity(value: Partial<LifecycleIdentity>): void {
  if (
    !value.instanceId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.instanceId)
  ) {
    throw new Error('invalid lifecycle instanceId');
  }
  if (!value.sha || !/^(?:[0-9a-f]{40,64}|unknown)$/i.test(value.sha)) {
    throw new Error('invalid lifecycle SHA');
  }
  if (!value.bootId || !/^[0-9a-f-]{36}$/i.test(value.bootId)) {
    throw new Error('invalid lifecycle boot ID');
  }
  if (!Number.isInteger(value.pid) || (value.pid ?? 0) < 1) {
    throw new Error('invalid lifecycle PID');
  }
}

export function parseLifecycleEvent(value: unknown): LifecycleEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lifecycle event must be an object');
  }
  const event = value as LifecycleEvent;
  validateIdentity(event);
  if (event.version !== LIFECYCLE_EVENT_VERSION)
    throw new Error('unsupported lifecycle event version');
  if (
    ![
      'started',
      'stop_intent',
      'stop_result',
      'shutdown_observed',
      'process_exit',
    ].includes(event.type)
  ) {
    throw new Error('invalid lifecycle event type');
  }
  if (!Number.isFinite(Date.parse(event.timestamp)))
    throw new Error('invalid lifecycle timestamp');
  if (
    event.type === 'stop_intent' &&
    !['promotion', 'operator_stop', 'recovery', 'rollback'].includes(
      event.intent ?? '',
    )
  ) {
    throw new Error('invalid lifecycle stop intent');
  }
  if (event.type === 'stop_intent') {
    if (
      !event.operationId ||
      !Number.isFinite(Date.parse(event.expiresAt ?? ''))
    ) {
      throw new Error('stop intent requires operationId and expiresAt');
    }
  }
  if (
    event.type === 'stop_result' &&
    (!event.operationId ||
      !['completed', 'already_absent', 'failed'].includes(event.result ?? ''))
  ) {
    throw new Error('stop result requires operationId and result');
  }
  if (
    event.type === 'shutdown_observed' &&
    !['SIGINT', 'SIGTERM', 'uncaughtException', 'startup_failure'].includes(
      event.reason ?? '',
    )
  ) {
    throw new Error('invalid lifecycle shutdown reason');
  }
  if (event.sender !== undefined && event.sender !== 'unknown')
    throw new Error('unsupported lifecycle sender identity');
  return event;
}

function openJournal(file: string): number {
  if (!isAbsolute(file))
    throw new Error('lifecycle journal path must be absolute');
  const fd = openSync(
    file,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const info = fstatSync(fd);
  if (!info.isFile()) {
    closeSync(fd);
    throw new Error('lifecycle journal must be a regular file');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error('lifecycle journal must be owned by the current user');
  }
  fchmodSync(fd, 0o600);
  return fd;
}

function readExistingJournal(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        'retained lifecycle journal is not a private current-user file',
      );
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve a process birth fingerprint with retries. The single-attempt
 * lookup can time out spuriously under host load (`ps` missed a 1s deadline
 * at load-40 and wedged the dogfood lifecycle, #1057), and the own-pid
 * acquisition path fails closed on null — so only return null once the
 * process is provably gone or every attempt failed against a live process.
 *
 * Used ONLY for the upfront own-pid check in the two lock acquisition entry
 * points. The in-loop reclaim/authority lookups keep the single-attempt
 * `processBirthFingerprint`: they run several times per contested
 * acquisition on the main thread, and their null is fail-SAFE (an owner
 * with an unverifiable birth is treated as alive), so retrying there would
 * multiply worst-case event-loop blocking for no correctness gain.
 * Injectable for tests.
 */
export function resolveProcessBirthFingerprint(
  pid: number,
  dependencies: {
    lookup?: (pid: number) => string | null;
    alive?: (pid: number) => boolean;
    attempts?: number;
  } = {},
): string | null {
  const lookup = dependencies.lookup ?? lookupProcessBirthOnce;
  const alive = dependencies.alive ?? processExists;
  const attempts = dependencies.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const birth = lookup(pid);
    if (birth) return birth;
    // A dead process legitimately has no fingerprint — that null is the
    // correct answer for stale-lock reclaim and must not be retried away.
    if (!alive(pid)) return null;
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lookupProcessBirthOnce(pid: number): string | null {
  return lookupProcessBirthFingerprint(pid);
}

// ---------------------------------------------------------------------------
// Lock algorithm core (#2646).
//
// The acquisition/reclaim algorithm is written ONCE as generator functions
// that yield their only two slow effects — sleeping and process
// birth-fingerprint lookups — to a driver. The sync driver (CLI and
// process-exit paths) interprets sleeps as `Atomics.wait` and lookups as the
// synchronous child-process probe, exactly as before; the async driver
// (server request paths) interprets sleeps as `await setTimeout` and lookups
// as the promisified probe, so a contended acquisition yields the event loop
// instead of freezing it for the whole wait. Every other correctness-bearing
// operation (linkSync publication, guard/claim election, quarantine
// compare-deletes, fsync) is fast synchronous fs work and stays inline, so
// both drivers speak the byte-identical on-disk lock/guard/claim protocol and
// sync and async holders interoperate.
//
// Birth-lookup effects carry a `source`:
// - 'lock'    → the acquisition's injectable lookup (`options.birthFingerprint`
//               when provided, else the cached default) — mirrors the old
//               `birthLookup` parameter threading.
// - 'default' → always the cached default lookup — mirrors the call sites
//               that hard-coded `processBirthFingerprint`.
// Both default paths share the short-TTL fingerprint cache in
// process-identity.mjs; `fresh: true` bypasses it (see `ownerAliveGen`).
// ---------------------------------------------------------------------------

type BirthSource = 'lock' | 'default';

type LockEffect =
  | { kind: 'sleep'; ms: number }
  | { kind: 'birth'; pid: number; source: BirthSource; fresh?: boolean };

type LockGen<T> = Generator<LockEffect, T, string | null | undefined>;

function* lookupBirth(
  pid: number,
  source: BirthSource,
  fresh = false,
): LockGen<string | null> {
  return (yield { kind: 'birth', pid, source, fresh }) ?? null;
}

function* sleep(ms: number): LockGen<void> {
  yield { kind: 'sleep', ms };
}

export type LockInspection = {
  owner: { pid: number; birth: string; token: string };
  ino: number;
  dev: number;
};

export function inspectLock(lock: string): LockInspection | null {
  let fd: number;
  try {
    fd = openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('journal lock is not a regular file');
    const owner = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      !owner.token ||
      !Number.isInteger(owner.pid) ||
      typeof owner.birth !== 'string' ||
      owner.birth.length === 0
    ) {
      throw new Error('journal lock metadata is invalid');
    }
    return { owner, ino: info.ino, dev: info.dev };
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces the old `lockOwnerAlive`/`ownerAliveWith` pair. A null lookup is
 * fail-safe (an owner with an unverifiable birth is treated as alive). A
 * cached MISMATCH is confirmed with a fresh probe before the owner is
 * declared dead: the cache entry could be the fingerprint of a previous
 * process that died and had its pid recycled within the TTL, and acting on it
 * would reclaim a live owner's lock.
 */
function* ownerAliveGen(
  owner: { pid: number; birth: string },
  source: BirthSource,
): LockGen<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const currentBirth = yield* lookupBirth(owner.pid, source);
  if (!currentBirth || owner.birth === currentBirth) return true;
  const freshBirth = yield* lookupBirth(owner.pid, source, true);
  return !freshBirth || owner.birth === freshBirth;
}

/**
 * Read-only owner-liveness probe (exported for the lifecycle doctor's tenure
 * check, #2669). Same algorithm as the in-lock liveness checks: it runs
 * `ownerAliveGen` through the synchronous driver, so it shares the TTL
 * fingerprint cache and the fresh-probe-on-mismatch confirmation.
 */
export function lockOwnerAlive(owner: LockInspection['owner']): boolean {
  return runLockGenSync(ownerAliveGen(owner, 'default'), {});
}

function sameLock(left: LockInspection | null, right: LockInspection): boolean {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token &&
      left.owner.pid === right.owner.pid &&
      left.owner.birth === right.owner.birth,
  );
}

function sameOptionalLock(
  left: LockInspection | null,
  right: LockInspection | null,
): boolean {
  return right === null ? left === null : sameLock(left, right);
}

export type FileMutationLockOptions = {
  timeoutMs?: number;
  claimLeaseMs?: number;
  electionMs?: number;
  birthFingerprint?: (pid: number) => string | null;
  hooks?: {
    afterStaleInspect?: (lock: string, observed: LockInspection) => void;
    afterGuardAcquired?: (lock: string, observed: LockInspection) => void;
    afterClaimPublished?: (lock: string) => void;
    afterElectionWon?: (lock: string) => void;
  };
};

type GuardInspection = LockInspection & {
  owner: LockInspection['owner'] & {
    createdAt: number;
    expiresAt: number;
    guarded: LockInspection;
  };
};

type ClaimInspection = {
  path: string;
  owner: {
    token: string;
    pid: number;
    birth: string;
    createdAt: number;
    expiresAt: number;
    guardIno: number;
    guardDev: number;
    guardToken: string;
  };
  ino: number;
  dev: number;
};

function inspectGuard(path: string): GuardInspection | null {
  const inspected = inspectLock(path) as GuardInspection | null;
  if (!inspected) return null;
  const guarded = inspected.owner.guarded;
  if (
    !Number.isFinite(inspected.owner.createdAt) ||
    !Number.isFinite(inspected.owner.expiresAt) ||
    !guarded ||
    !Number.isInteger(guarded.ino) ||
    !Number.isInteger(guarded.dev) ||
    !guarded.owner?.token ||
    !guarded.owner?.birth
  ) {
    throw new Error('lock guard metadata is invalid');
  }
  return inspected;
}

function sameGuard(
  left: GuardInspection | null,
  right: GuardInspection,
): boolean {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token &&
      left.owner.pid === right.owner.pid &&
      left.owner.birth === right.owner.birth,
  );
}

function inspectClaim(path: string): ClaimInspection | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    const owner = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      !info.isFile() ||
      !owner.token ||
      !owner.birth ||
      !Number.isInteger(owner.pid) ||
      !Number.isFinite(owner.createdAt) ||
      !Number.isFinite(owner.expiresAt)
    )
      throw new Error('guard reclamation claim metadata is invalid');
    return { path, owner, ino: info.ino, dev: info.dev };
  } finally {
    closeSync(fd);
  }
}

function sameClaim(
  left: ClaimInspection | null,
  right: ClaimInspection,
): boolean {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token,
  );
}

function* deleteClaimGen(
  claim: ClaimInspection,
  source: BirthSource = 'default',
  requireExpiredDead = false,
): LockGen<void> {
  const current = inspectClaim(claim.path);
  if (!sameClaim(current, claim)) return;
  if (
    requireExpiredDead &&
    current &&
    (current.owner.expiresAt > Date.now() ||
      (yield* ownerAliveGen(current.owner, source)))
  )
    return;
  const quarantine = `${claim.path}.stale-${randomUUID()}`;
  renameSync(claim.path, quarantine);
  if (!sameClaim(inspectClaim(quarantine), claim)) {
    if (!existsSync(claim.path) && existsSync(quarantine)) {
      renameSync(quarantine, claim.path);
    }
    throw new Error('guard reclamation claim changed during cleanup');
  }
  rmSync(quarantine, { force: true });
}

function* activeClaimsGen(
  lock: string,
  guard: GuardInspection | undefined,
  source: BirthSource = 'default',
): LockGen<ClaimInspection[]> {
  const directory = `${lock}.guard.claims`;
  if (!existsSync(directory)) return [];
  const now = Date.now();
  const claims: ClaimInspection[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.claim')) continue;
    const claim = inspectClaim(join(directory, entry));
    if (!claim) continue;
    // Expiry makes a dead claim collectible; it never revokes a live owner's authority.
    if (claim.owner.expiresAt <= now) {
      if (!(yield* ownerAliveGen(claim.owner, source))) {
        yield* deleteClaimGen(claim, source, true);
        continue;
      }
    }
    if (
      !guard ||
      (claim.owner.guardIno === guard.ino &&
        claim.owner.guardDev === guard.dev &&
        claim.owner.guardToken === guard.owner.token)
    )
      claims.push(claim);
  }
  return claims.sort(
    (left, right) =>
      left.owner.createdAt - right.owner.createdAt ||
      left.owner.token.localeCompare(right.owner.token),
  );
}

function* claimStillAuthoritativeGen(
  lock: string,
  guard: GuardInspection,
  claim: ClaimInspection,
  source: BirthSource,
): LockGen<boolean> {
  const current = inspectClaim(claim.path);
  if (!current || !sameClaim(current, claim)) return false;
  if (current.owner.pid !== process.pid) return false;
  // Own-pid compare: our own fingerprint is stable for the process lifetime,
  // so a cached value needs no fresh-probe confirmation here.
  if ((yield* lookupBirth(process.pid, source)) !== current.owner.birth)
    return false;
  if (!sameGuard(inspectGuard(`${lock}.guard`), guard)) return false;
  return sameClaim(
    (yield* activeClaimsGen(lock, guard, source))[0] ?? null,
    current,
  );
}

function publishGuard(
  lock: string,
  observed: LockInspection,
  birth: string,
): GuardInspection | null {
  const guardPath = `${lock}.guard`;
  const token = randomUUID();
  const temporary = `${guardPath}.${token}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    fd,
    JSON.stringify({
      token,
      pid: process.pid,
      birth,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5_000,
      guarded: observed,
    }),
  );
  fsyncSync(fd);
  closeSync(fd);
  try {
    linkSync(temporary, guardPath);
    return inspectGuard(guardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return null;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function deleteGuard(path: string, observed: GuardInspection): void {
  if (!sameGuard(inspectGuard(path), observed)) return;
  const quarantine = `${path}.stale-${randomUUID()}`;
  renameSync(path, quarantine);
  if (!sameGuard(inspectGuard(quarantine), observed)) {
    if (!existsSync(path) && existsSync(quarantine))
      renameSync(quarantine, path);
    throw new Error('lock guard changed during compare-delete');
  }
  rmSync(quarantine, { force: true });
}

function* reclaimOrphanGuardGen(
  lock: string,
  options: FileMutationLockOptions,
  birth: string,
): LockGen<boolean> {
  const guardPath = `${lock}.guard`;
  const guard = inspectGuard(guardPath);
  if (!guard) return true;
  if (yield* ownerAliveGen(guard.owner, 'lock')) return false;
  const directory = `${guardPath}.claims`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const claimPath = join(directory, `${token}.claim`);
  const claimTemporary = `${claimPath}.tmp`;
  const createdAt = Date.now();
  const fd = openSync(
    claimTemporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    fd,
    JSON.stringify({
      token,
      pid: process.pid,
      birth,
      createdAt,
      expiresAt: createdAt + (options.claimLeaseMs ?? 250),
      guardIno: guard.ino,
      guardDev: guard.dev,
      guardToken: guard.owner.token,
    }),
  );
  fsyncSync(fd);
  closeSync(fd);
  linkSync(claimTemporary, claimPath);
  rmSync(claimTemporary, { force: true });
  const ownClaim = inspectClaim(claimPath);
  if (!ownClaim) throw new Error('failed to publish guard reclamation claim');
  options.hooks?.afterClaimPublished?.(lock);
  yield* sleep(options.electionMs ?? 15);
  const winner = (yield* activeClaimsGen(lock, guard, 'lock'))[0];
  if (!sameClaim(winner ?? null, ownClaim)) {
    yield* deleteClaimGen(ownClaim);
    return false;
  }
  options.hooks?.afterElectionWon?.(lock);
  try {
    if (
      !(yield* claimStillAuthoritativeGen(lock, guard, ownClaim, 'lock')) ||
      (yield* ownerAliveGen(guard.owner, 'lock'))
    )
      return false;
    const canonical = inspectLock(lock);
    if (sameLock(canonical, guard.owner.guarded)) {
      if (
        !(yield* claimStillAuthoritativeGen(lock, guard, ownClaim, 'lock')) ||
        !sameLock(inspectLock(lock), guard.owner.guarded)
      )
        return false;
      const quarantine = `${lock}.orphan-${randomUUID()}`;
      renameSync(lock, quarantine);
      if (
        !(yield* claimStillAuthoritativeGen(lock, guard, ownClaim, 'lock')) ||
        inspectLock(lock) !== null ||
        !sameLock(inspectLock(quarantine), guard.owner.guarded)
      ) {
        if (!existsSync(lock) && existsSync(quarantine))
          renameSync(quarantine, lock);
        return false;
      }
      rmSync(quarantine, { force: true });
    }
    if (!(yield* claimStillAuthoritativeGen(lock, guard, ownClaim, 'lock')))
      return false;
    const canonicalBeforeGuardDelete = inspectLock(lock);
    if (sameLock(canonicalBeforeGuardDelete, guard.owner.guarded)) return false;
    const guardQuarantine = `${guardPath}.stale-${randomUUID()}`;
    renameSync(guardPath, guardQuarantine);
    const currentClaim = inspectClaim(ownClaim.path);
    if (
      !currentClaim ||
      !sameClaim(currentClaim, ownClaim) ||
      (yield* lookupBirth(process.pid, 'lock')) !== ownClaim.owner.birth ||
      !sameClaim(
        (yield* activeClaimsGen(lock, guard, 'lock'))[0] ?? null,
        ownClaim,
      ) ||
      !sameGuard(inspectGuard(guardQuarantine), guard) ||
      !sameOptionalLock(inspectLock(lock), canonicalBeforeGuardDelete)
    ) {
      if (!existsSync(guardPath) && existsSync(guardQuarantine)) {
        renameSync(guardQuarantine, guardPath);
      }
      return false;
    }
    rmSync(guardQuarantine, { force: true });
    return true;
  } finally {
    yield* deleteClaimGen(ownClaim);
  }
}

/**
 * Own-pid birth resolution for lock/guard ownership. An injected
 * `birthFingerprint` (tests) stays single-call; the default path retries a
 * spurious null against a live process (#1057) exactly like
 * `resolveProcessBirthFingerprint`, but through the driver so the async
 * acquisition path probes without blocking the event loop.
 */
function* ownBirthGen(
  options: FileMutationLockOptions,
): LockGen<string | null> {
  if (options.birthFingerprint) {
    return yield* lookupBirth(process.pid, 'lock');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const birth = yield* lookupBirth(process.pid, 'default');
    if (birth) return birth;
    // A dead process legitimately has no fingerprint — that null is the
    // correct answer and must not be retried away.
    if (!processExists(process.pid)) return null;
  }
  return null;
}

function* guardedDeleteLockGen(
  lock: string,
  observed: LockInspection,
  options: FileMutationLockOptions,
): LockGen<boolean> {
  if ((yield* activeClaimsGen(lock, undefined)).length > 0) return false;
  // Own-pid, fail-closed: retry spurious lookup failures (#1057). Injected
  // fingerprints (tests) stay single-call.
  const birth = yield* ownBirthGen(options);
  if (!birth)
    throw new Error(
      'process birth fingerprint is required for guard ownership',
    );
  const guardPath = `${lock}.guard`;
  const guard = publishGuard(lock, observed, birth);
  if (!guard) return false;
  try {
    options.hooks?.afterGuardAcquired?.(lock, observed);
    if (!sameGuard(inspectGuard(guardPath), guard)) return false;
    if (!sameLock(inspectLock(lock), observed)) return false;
    const quarantine = `${lock}.stale-${randomUUID()}`;
    renameSync(lock, quarantine);
    const moved = inspectLock(quarantine);
    if (!sameLock(moved, observed)) {
      if (!existsSync(lock) && existsSync(quarantine))
        renameSync(quarantine, lock);
      throw new Error('journal lock changed during compare-delete');
    }
    rmSync(quarantine, { force: true });
    return true;
  } finally {
    deleteGuard(guardPath, guard);
  }
}

function* deletePublishedUnderExistingGuardGen(
  lock: string,
  owned: LockInspection,
): LockGen<void> {
  if (
    (!existsSync(`${lock}.guard`) &&
      (yield* activeClaimsGen(lock, undefined)).length === 0) ||
    !sameLock(inspectLock(lock), owned)
  )
    return;
  const quarantine = `${lock}.aborted-${randomUUID()}`;
  renameSync(lock, quarantine);
  if (!sameLock(inspectLock(quarantine), owned)) {
    if (!existsSync(lock) && existsSync(quarantine))
      renameSync(quarantine, lock);
    throw new Error('published lock changed during guarded abort');
  }
  rmSync(quarantine, { force: true });
}

function* acquireGen(
  lock: string,
  options: FileMutationLockOptions,
): LockGen<LockInspection> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Own-pid, fail-closed: retry spurious lookup failures (#1057). Injected
  // fingerprints (tests) stay single-call; the in-loop reclaim lookups stay
  // single-attempt (their null is fail-safe).
  const birth = yield* ownBirthGen(options);
  if (!birth)
    throw new Error('process birth fingerprint is required for lock ownership');
  const token = randomUUID();
  const temporary = `${lock}.${token}.tmp`;
  const deadline = Date.now() + timeoutMs;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    descriptor,
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      birth,
      token,
      acquiredAt: new Date().toISOString(),
    })}\n`,
  );
  fsyncSync(descriptor);
  closeSync(descriptor);
  while (true) {
    if (existsSync(`${lock}.guard`)) {
      try {
        if (yield* reclaimOrphanGuardGen(lock, options, birth)) continue;
      } catch {
        // Invalid or unverifiable guard ownership fails closed.
      }
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        throw new Error('lifecycle journal lock guard is held');
      }
      yield* sleep(10);
      continue;
    }
    if ((yield* activeClaimsGen(lock, undefined)).length > 0) {
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        throw new Error('lifecycle journal guard reclamation is active');
      }
      yield* sleep(10);
      continue;
    }
    try {
      linkSync(temporary, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let observed: LockInspection | null = null;
      try {
        observed = inspectLock(lock);
      } catch {
        // Atomic publication makes this transient; retry rather than reclaim.
      }
      if (observed && !(yield* ownerAliveGen(observed.owner, 'default'))) {
        options.hooks?.afterStaleInspect?.(lock, observed);
        yield* guardedDeleteLockGen(lock, observed, options);
        continue;
      }
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        throw new Error('lifecycle journal lock is held by a live process');
      }
      yield* sleep(10);
      continue;
    }
    const owned = inspectLock(lock);
    if (!owned) throw new Error('published lifecycle lock disappeared');
    if (
      existsSync(`${lock}.guard`) ||
      (yield* activeClaimsGen(lock, undefined)).length > 0
    ) {
      while (
        (existsSync(`${lock}.guard`) ||
          (yield* activeClaimsGen(lock, undefined)).length > 0) &&
        Date.now() < deadline
      ) {
        yield* sleep(10);
      }
      if (sameLock(inspectLock(lock), owned)) {
        yield* guardedDeleteLockGen(lock, owned, options);
      }
      if (Date.now() >= deadline && sameLock(inspectLock(lock), owned)) {
        yield* deletePublishedUnderExistingGuardGen(lock, owned);
        rmSync(temporary, { force: true });
        throw new Error('lifecycle journal lock guard is held');
      }
      continue;
    }
    rmSync(temporary, { force: true });
    return owned;
  }
}

function resolveBirthEffectSync(
  effect: Extract<LockEffect, { kind: 'birth' }>,
  options: FileMutationLockOptions,
): string | null {
  if (effect.source === 'lock' && options.birthFingerprint)
    return options.birthFingerprint(effect.pid);
  return lookupProcessBirthFingerprintCached(effect.pid, {
    fresh: effect.fresh,
  });
}

function runLockGenSync<T>(
  generator: LockGen<T>,
  options: FileMutationLockOptions,
): T {
  let step = generator.next();
  while (!step.done) {
    const effect = step.value;
    if (effect.kind === 'sleep') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, effect.ms);
      step = generator.next();
      continue;
    }
    let birth: string | null;
    try {
      birth = resolveBirthEffectSync(effect, options);
    } catch (error) {
      step = generator.throw(error);
      continue;
    }
    step = generator.next(birth);
  }
  return step.value;
}

async function runLockGenAsync<T>(
  generator: LockGen<T>,
  options: FileMutationLockOptions,
): Promise<T> {
  let step = generator.next();
  while (!step.done) {
    const effect = step.value;
    if (effect.kind === 'sleep') {
      await sleepAsync(effect.ms);
      step = generator.next();
      continue;
    }
    let birth: string | null;
    try {
      birth =
        effect.source === 'lock' && options.birthFingerprint
          ? options.birthFingerprint(effect.pid)
          : await lookupProcessBirthFingerprintCachedAsync(effect.pid, {
              fresh: effect.fresh,
            });
    } catch (error) {
      step = generator.throw(error);
      continue;
    }
    step = generator.next(birth);
  }
  return step.value;
}

export function acquireFileMutationLock(
  lock: string,
  options: FileMutationLockOptions = {},
): () => void {
  const owned = runLockGenSync(acquireGen(lock, options), options);
  return () => {
    try {
      runLockGenSync(guardedDeleteLockGen(lock, owned, options), options);
    } catch {}
  };
}

/**
 * Async twin of `acquireFileMutationLock` (#2646): same algorithm, same
 * on-disk lock/guard/claim protocol (sync and async holders interoperate),
 * same deadline semantics and error messages — but a contended acquisition
 * awaits its retry sleeps and performs its process-liveness probes with the
 * promisified child-process probe, so the server's event loop keeps serving
 * requests while this caller waits. Server-side request/boot paths should
 * prefer this variant; short-lived CLI and process-exit paths may keep the
 * sync form.
 */
export async function acquireFileMutationLockAsync(
  lock: string,
  options: FileMutationLockOptions = {},
): Promise<() => Promise<void>> {
  const owned = await runLockGenAsync(acquireGen(lock, options), options);
  return async () => {
    try {
      await runLockGenAsync(
        guardedDeleteLockGen(lock, owned, options),
        options,
      );
    } catch {}
  };
}

function acquireJournalLock(
  file: string,
  options: FileMutationLockOptions = {},
): () => void {
  return acquireFileMutationLock(`${file}.lock`, options);
}

function copyDescriptor(source: number, target: number): void {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const count = readSync(source, buffer, 0, buffer.length, position);
    if (count === 0) break;
    let written = 0;
    while (written < count)
      written += writeSync(target, buffer, written, count - written);
    position += count;
  }
}

function rotateDescriptor(file: string, fd: number): void {
  const opened = fstatSync(fd);
  const temporary = join(
    dirname(file),
    `.lifecycle-journal-${randomUUID()}.tmp`,
  );
  let tempFd: number | null = null;
  try {
    tempFd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    copyDescriptor(fd, tempFd);
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    renameSync(temporary, `${file}.previous`);
    // `.previous` is durable HISTORY — readJournal reads it back alongside the
    // live file — so unlike this module's link-based guard claims it is not
    // ephemeral coordination that a dead process takes with it. Without this
    // a power loss after the rename loses the rotated half of the journal and
    // the reader just sees a shorter history (station#3215 delta review).
    fsyncDirectorySync(dirname(file));
    const current = lstatSync(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev
    ) {
      throw new Error('lifecycle journal pathname changed during rotation');
    }
    // libuv can't ftruncate a descriptor opened with O_APPEND on Windows
    // (EPERM) - open a separate, non-append descriptor to the same file
    // just for the truncate. O_APPEND always seeks to end-of-file before
    // each write at the OS level, so the original `fd` needs no position
    // adjustment once the file is empty.
    const truncateFd = openSync(file, constants.O_RDWR);
    try {
      ftruncateSync(truncateFd, 0);
      fsyncSync(truncateFd);
    } finally {
      closeSync(truncateFd);
    }
  } finally {
    if (tempFd !== null) closeSync(tempFd);
    rmSync(temporary, { force: true });
  }
}

export function appendLifecycleEvent(
  file: string,
  input: Omit<LifecycleEvent, 'version' | 'eventId'> & {
    version?: 1;
    eventId?: string;
  },
  options: {
    maxBytes?: number;
    lockTimeoutMs?: number;
    lockOptions?: FileMutationLockOptions;
  } = {},
): LifecycleEvent {
  const event = parseLifecycleEvent({
    ...input,
    eventId: input.eventId ?? randomUUID(),
    version: LIFECYCLE_EVENT_VERSION,
  });
  const line = `${JSON.stringify(event)}\n`;
  const release = acquireJournalLock(file, {
    ...options.lockOptions,
    timeoutMs: options.lockTimeoutMs ?? options.lockOptions?.timeoutMs,
  });
  let fd: number | null = null;
  try {
    fd = openJournal(file);
    if (
      fstatSync(fd).size + Buffer.byteLength(line) >
      (options.maxBytes ?? DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES)
    ) {
      rotateDescriptor(file, fd);
    }
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
    release();
  }
  return event;
}

export function readLifecycleEvents(
  file: string,
  limit = 200,
): LifecycleEvent[] {
  const release = acquireJournalLock(file);
  try {
    const sources = [`${file}.previous`, file]
      .filter((candidate) => existsSync(candidate))
      .flatMap((candidate) => readExistingJournal(candidate).split('\n'));
    const seen = new Set<string>();
    return sources
      .filter(Boolean)
      .map((line) => parseLifecycleEvent(JSON.parse(line)))
      .filter((event) => {
        const key = event.eventId ?? JSON.stringify(event);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-Math.max(1, limit));
  } finally {
    release();
  }
}

function sameIdentity(
  event: LifecycleIdentity,
  identity: LifecycleIdentity,
): boolean {
  return (
    event.instanceId === identity.instanceId &&
    event.sha === identity.sha &&
    event.bootId === identity.bootId &&
    event.pid === identity.pid
  );
}

export function classifyLifecycleExit(
  events: LifecycleEvent[],
  identity: LifecycleIdentity,
): {
  classification: ExitClassification;
  event: LifecycleEvent | null;
  intent: StopIntent | null;
  sender: 'unknown';
} {
  const matching = events.filter((event) => sameIdentity(event, identity));
  const intentEvent = [...matching]
    .reverse()
    .find((event) => event.type === 'stop_intent');
  const intent = intentEvent?.intent ?? null;
  const actual =
    [...matching]
      .reverse()
      .find(
        (event) =>
          event.type === 'process_exit' || event.type === 'shutdown_observed',
      ) ?? null;
  const observedSignal = [...matching]
    .reverse()
    .find(
      (event) =>
        event.type === 'shutdown_observed' &&
        (event.reason === 'SIGINT' || event.reason === 'SIGTERM'),
    );
  const expected: Partial<Record<StopIntent, ExitClassification>> = {
    promotion: 'expected_promotion',
    operator_stop: 'operator_stop',
    recovery: 'expected_recovery_stop',
    rollback: 'expected_rollback',
  };
  const result = intentEvent?.operationId
    ? matching.find(
        (event) =>
          event.type === 'stop_result' &&
          event.operationId === intentEvent.operationId,
      )
    : undefined;
  const actualAt = actual ? Date.parse(actual.timestamp) : Number.NaN;
  const intentValid =
    Boolean(intent && intentEvent?.operationId) &&
    (result?.result === 'completed' || result?.result === 'already_absent') &&
    Number.isFinite(actualAt) &&
    actualAt >= Date.parse(intentEvent!.timestamp) &&
    actualAt <= Date.parse(result!.timestamp) &&
    actualAt <= Date.parse(intentEvent!.expiresAt!);
  if (intentValid)
    return {
      classification: expected[intent!]!,
      event: actual,
      intent,
      sender: 'unknown',
    };
  if (!actual)
    return {
      classification: 'crash_unobserved',
      event: null,
      intent: null,
      sender: 'unknown',
    };
  if (observedSignal || actual.signal) {
    return {
      classification: 'unexpected_signal',
      event: actual,
      intent: null,
      sender: 'unknown',
    };
  }
  return {
    classification: 'crash',
    event: actual,
    intent: null,
    sender: 'unknown',
  };
}
