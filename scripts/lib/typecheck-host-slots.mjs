/**
 * Host-wide typecheck slots: at most N `tsc` programs run at once on this
 * machine, across EVERY worktree and every caller (the `typecheck` aggregate,
 * the pre-push hook, `ci:fast`, and ad-hoc `npm run typecheck:*`).
 *
 * Why this exists: each `npm run typecheck` starts 13 cold `tsc` programs, the
 * largest at ~3 GB RSS, and `npm-lane-aggregate` bounds concurrency only
 * within ONE invocation. Several agent sessions typechecking their own
 * worktrees at once ran 7-12 compilers together on a 48 GB host, pushed load
 * to ~88 and filled swap. A per-invocation cap cannot see the other
 * invocations; a slot shared through the filesystem can.
 *
 * ## Protocol
 *
 * A slot is the file `<dir>/slot-<i>.lock`, for i in [0, N). Acquiring writes
 * the holder record to a private temp file and publishes it with `link(2)`,
 * which fails with EEXIST when the slot is taken: the claim is atomic and a
 * reader never sees a half-written record. The record names the holder's pid
 * and, where it is cheap to read, its process birth fingerprint
 * (`packages/shared/src/process-identity.mjs`), so a recycled pid is not
 * mistaken for the original holder.
 *
 * The holder is the process that runs `tsc` itself (`scripts/tsc-slot.mjs`
 * loads the compiler in-process), so the slot's lifetime is exactly the
 * compiler's: a normal exit or `process.exit` releases it from an `exit`
 * hook, and a crash, SIGKILL or OOM kill leaves a record whose pid is dead,
 * which the next waiter reclaims.
 *
 * ## What it does not guarantee
 *
 * This is a LOAD cap, not a mutual-exclusion lock guarding shared data. One
 * interleaving can briefly admit N+1: two waiters both judge the same dead
 * holder stale, the first reclaims and re-claims the slot, the second's
 * reclaim rename then moves the FIRST's fresh record, and a third process
 * claims the empty slot before the second can put it back. The second
 * detects this (the moved record is not the stale one it observed), restores
 * the record when the slot is still empty, and otherwise reports the
 * over-admission on stderr. It needs a crashed holder plus a three-way race
 * inside a few microseconds; it cannot deadlock and cannot leak a slot.
 *
 * On Windows the birth fingerprint costs a PowerShell start (seconds), so
 * records there carry no fingerprint. A live pid with no fingerprint is
 * trusted as the holder until the record is older than
 * `UNVERIFIED_HOLDER_STALE_MS`, far longer than any compile, which bounds how
 * long a recycled pid can pin a slot.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir as osTmpdir, totalmem as osTotalmem } from 'node:os';
import { join } from 'node:path';
import { lookupProcessBirthFingerprint } from '../../packages/shared/src/process-identity.mjs';

const SLOT_DIR_ENV = 'STATION_TYPECHECK_SLOT_DIR';
const SLOT_COUNT_ENV = 'STATION_TYPECHECK_SLOTS';
const SLOT_WAIT_ENV = 'STATION_TYPECHECK_SLOT_WAIT_MS';
/**
 * Set on the holder's own environment. A nested acquisition in the same
 * process tree (a slot holder that starts another slotted program) would
 * otherwise wait on its own ancestor's slot; with N=1 that is a deadlock.
 */
export const SLOT_HELD_ENV = 'STATION_TYPECHECK_SLOT_HELD';

const GIB = 1024 ** 3;
/**
 * One slot per 8 GiB of RAM, between 1 and 4. The largest project
 * (`tsconfig.tests.json`) peaks at ~3 GB RSS, so 4 slots on the 48 GB
 * development host bound typecheck memory near 12 GB; a 16 GB CI runner
 * gets 2, which keeps its typecheck lane from serializing completely.
 */
const BYTES_PER_SLOT = 8 * GIB;
const MAX_DEFAULT_SLOTS = 4;
const MAX_CONFIGURED_SLOTS = 64;
/** A full aggregate on a contended host legitimately queues for minutes. */
const DEFAULT_WAIT_MS = 45 * 60_000;
export const UNVERIFIED_HOLDER_STALE_MS = 6 * 60 * 60_000;
/** A record that cannot be parsed is durable corruption once this old. */
export const CORRUPT_RECORD_STALE_MS = 60_000;
const BIRTH_RECHECK_MS = 30_000;
const PROGRESS_LOG_MS = 60_000;

export function resolveSlotCount({
  env = process.env,
  totalmem = osTotalmem(),
} = {}) {
  const raw = env[SLOT_COUNT_ENV];
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_CONFIGURED_SLOTS
    ) {
      throw new Error(
        `${SLOT_COUNT_ENV}=${JSON.stringify(raw)} is not an integer between 1 and ${MAX_CONFIGURED_SLOTS}`,
      );
    }
    return parsed;
  }
  return Math.max(
    1,
    Math.min(MAX_DEFAULT_SLOTS, Math.floor(totalmem / BYTES_PER_SLOT)),
  );
}

function resolveSlotDirectory({ env = process.env, tmpdir = osTmpdir() } = {}) {
  const override = env[SLOT_DIR_ENV];
  return override ? override : join(tmpdir, 'station-typecheck-slots');
}

function resolveWaitMs({ env = process.env } = {}) {
  const raw = env[SLOT_WAIT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${SLOT_WAIT_ENV}=${JSON.stringify(raw)} is not a non-negative integer (milliseconds)`,
    );
  }
  return parsed;
}

export function slotPath(dir, index) {
  return join(dir, `slot-${index}.lock`);
}

/** Only ESRCH proves a pid is gone; EPERM and anything else is "maybe alive". */
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * The fingerprint this process records for itself. Windows returns null by
 * design (see the module comment): the PowerShell probe would add seconds to
 * every compile.
 */
export function ownBirthFingerprint({
  platform = process.platform,
  pid = process.pid,
  lookup = lookupProcessBirthFingerprint,
} = {}) {
  if (platform === 'win32') return null;
  return lookup(pid) ?? null;
}

/**
 * @returns {{ record: any, corrupt: boolean, missing: boolean, busy?: boolean, mtimeMs: number | null }}
 */
/**
 * Windows reports a file that another process is renaming, deleting or
 * scanning (antivirus) as EPERM/EBUSY/EACCES. There that is contention, so
 * the slot is skipped for this pass; on POSIX the same codes are a real
 * permission problem and propagate.
 */
export function isTransientContention(error, platform = process.platform) {
  return (
    platform === 'win32' &&
    ['EPERM', 'EBUSY', 'EACCES'].includes(String(error?.code))
  );
}

function readSlotRecord(path) {
  let text;
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { record: null, corrupt: false, missing: true, mtimeMs };
    if (isTransientContention(error))
      return {
        record: null,
        corrupt: false,
        missing: false,
        busy: true,
        mtimeMs,
      };
    throw error;
  }
  try {
    const record = JSON.parse(text);
    if (record && typeof record === 'object' && Number.isInteger(record.pid))
      return { record, corrupt: false, missing: false, mtimeMs };
  } catch {
    // fall through
  }
  return { record: null, corrupt: true, missing: false, mtimeMs };
}

/**
 * Is the recorded holder still running? Fail-safe: anything short of proof
 * of death (dead pid, or a live pid whose birth differs from the record)
 * keeps the slot held.
 *
 * @param {any} record
 * @param {{ now?: number, pidAlive?: (pid: number) => boolean, lookupBirth?: (pid: number) => string | null, birthCache?: Map<string, number> }} [options]
 */
export function holderIsLive(
  record,
  {
    now = Date.now(),
    pidAlive = defaultPidAlive,
    lookupBirth = (pid) => lookupProcessBirthFingerprint(pid),
    birthCache,
  } = {},
) {
  if (!record || !Number.isInteger(record.pid) || record.pid < 1) return false;
  if (!pidAlive(record.pid)) return false;
  if (typeof record.start === 'string' && record.start) {
    const key = `${record.pid}:${record.start}`;
    const verifiedAt = birthCache?.get(key);
    if (verifiedAt !== undefined && now - verifiedAt < BIRTH_RECHECK_MS)
      return true;
    const observed = lookupBirth(record.pid);
    // An unreadable birth is not evidence the pid was recycled.
    if (observed == null) return true;
    if (observed !== record.start) return false;
    birthCache?.set(key, now);
    return true;
  }
  const acquiredAt = Number(record.acquiredAt);
  if (!Number.isFinite(acquiredAt)) return true;
  return now - acquiredAt <= UNVERIFIED_HOLDER_STALE_MS;
}

function writePrivateFile(path, text) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function unlinkQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Claim slot `index` if it is free. Returns false on EEXIST; any other error
 * is a real problem (unwritable directory) and propagates.
 */
function tryClaimSlot(dir, index, record) {
  const target = slotPath(dir, index);
  const staging = join(dir, `.staging-${randomUUID()}`);
  writePrivateFile(staging, `${JSON.stringify(record)}\n`);
  try {
    linkSync(staging, target);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST' || isTransientContention(error)) return false;
    throw error;
  } finally {
    unlinkQuietly(staging);
  }
}

/**
 * Remove a slot record judged stale, but only the one that was judged:
 * `observedNonce` is the nonce read before the verdict (null for a corrupt
 * record). The record is first moved aside atomically so no other process
 * can be half-way through the same removal; if what was moved is NOT the
 * judged record, another process has already reclaimed and re-claimed the
 * slot, and its record is put back.
 *
 * @returns {'reclaimed' | 'gone' | 'busy' | 'restored' | 'overadmitted'}
 */
export function reclaimStaleSlot(
  dir,
  index,
  observedNonce,
  { warn = (message) => process.stderr.write(`${message}\n`) } = {},
) {
  const target = slotPath(dir, index);
  const aside = join(dir, `.reclaim-${randomUUID()}`);
  try {
    renameSync(target, aside);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'gone';
    if (isTransientContention(error)) return 'busy';
    throw error;
  }
  const moved = readSlotRecord(aside);
  const movedNonce = moved.record?.nonce ?? null;
  // A moved record that cannot be read is put back rather than deleted.
  if (!moved.busy && movedNonce === observedNonce) {
    unlinkQuietly(aside);
    return 'reclaimed';
  }
  try {
    linkSync(aside, target);
    unlinkQuietly(aside);
    return 'restored';
  } catch (error) {
    unlinkQuietly(aside);
    if (error?.code !== 'EEXIST') throw error;
    warn(
      `[typecheck-slots] slot ${index} was reclaimed concurrently; pid ${moved.record?.pid ?? '?'} keeps running outside the cap until it exits.`,
    );
    return 'overadmitted';
  }
}

function describeHolders(holders) {
  return holders
    .map(
      (holder) =>
        `pid ${holder.pid}${holder.label ? ` (${holder.label})` : ''}${
          holder.cwd ? ` in ${holder.cwd}` : ''
        }`,
    )
    .join('; ');
}

function recordIsStale(observed, liveness) {
  if (observed.corrupt)
    return (
      observed.mtimeMs !== null &&
      liveness.now - observed.mtimeMs > CORRUPT_RECORD_STALE_MS
    );
  return !holderIsLive(observed.record, liveness);
}

/**
 * Try one slot. Returns `true` when claimed; otherwise the live holder's
 * record (or null when the slot changed hands mid-look).
 */
function claimOrObserve(dir, index, record, liveness) {
  if (tryClaimSlot(dir, index, record)) return true;
  const observed = readSlotRecord(slotPath(dir, index));
  // Released between our link and read: claim it on this pass.
  if (observed.missing) return tryClaimSlot(dir, index, record) || null;
  // Unreadable right now (Windows contention): neither free nor a holder.
  if (observed.busy) return null;
  if (!recordIsStale(observed, liveness)) return observed.record;
  const outcome = reclaimStaleSlot(dir, index, observed.record?.nonce ?? null, {
    warn: liveness.warn,
  });
  if (outcome !== 'reclaimed' && outcome !== 'gone') return null;
  return tryClaimSlot(dir, index, record) || null;
}

/**
 * One pass over every slot: claim the first free one, reclaiming stale
 * records on the way. Returns the claimed index, or the live holders seen.
 */
function scanSlots(dir, slots, record, liveness) {
  const holders = [];
  for (let index = 0; index < slots; index += 1) {
    const result = claimOrObserve(dir, index, record, liveness);
    if (result === true) return { index, holders };
    if (result) holders.push(result);
  }
  return { index: -1, holders };
}

function releaser(path, nonce) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readSlotRecord(path).record?.nonce === nonce) unlinkQuietly(path);
  };
}

function forLabel(label) {
  return label ? ` for ${label}` : '';
}

/**
 * Wait (bounded) for a host-wide typecheck slot.
 *
 * @param {{
 *   label?: string,
 *   env?: NodeJS.ProcessEnv,
 *   dir?: string,
 *   slots?: number,
 *   waitMs?: number,
 *   pid?: number,
 *   start?: string | null,
 *   pollMs?: number,
 *   pidAlive?: (pid: number) => boolean,
 *   lookupBirth?: (pid: number) => string | null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (message: string) => void,
 * }} [options]
 * @returns {Promise<{ index: number, dir: string, slots: number, reentrant: boolean, release: () => void }>}
 */
export async function acquireTypecheckSlot({
  label = '',
  env = process.env,
  dir = resolveSlotDirectory({ env }),
  slots = resolveSlotCount({ env }),
  waitMs = resolveWaitMs({ env }),
  pid = process.pid,
  start,
  pollMs = 500,
  pidAlive,
  lookupBirth,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (env[SLOT_HELD_ENV]) {
    return { index: -1, dir, slots, reentrant: true, release: () => {} };
  }
  mkdirSync(dir, { recursive: true });
  const record = {
    pid,
    start: start === undefined ? ownBirthFingerprint({ pid }) : start,
    nonce: randomUUID(),
    acquiredAt: now(),
    label,
    cwd: process.cwd(),
  };
  const birthCache = new Map();
  const startedAt = now();
  let lastLogAt = null;
  for (;;) {
    const liveness = {
      now: now(),
      pidAlive,
      lookupBirth,
      birthCache,
      warn: log,
    };
    record.acquiredAt = liveness.now;
    const { index, holders } = scanSlots(dir, slots, record, liveness);
    const seconds = Math.round((now() - startedAt) / 1000);
    if (index >= 0) {
      if (lastLogAt !== null)
        log(
          `[typecheck-slots] acquired slot ${index + 1}/${slots} after ${seconds}s${forLabel(label)}.`,
        );
      const release = releaser(slotPath(dir, index), record.nonce);
      return { index, dir, slots, reentrant: false, release };
    }
    if (now() - startedAt >= waitMs) {
      throw new Error(
        `FAIL: waited ${seconds}s for a host typecheck slot${forLabel(label)}; all ${slots} are held: ${describeHolders(holders)}. ` +
          `Slots live in ${dir} (${SLOT_DIR_ENV}); raise ${SLOT_WAIT_ENV} to wait longer, or ${SLOT_COUNT_ENV} if the host has memory to spare.`,
      );
    }
    if (lastLogAt === null || now() - lastLogAt >= PROGRESS_LOG_MS) {
      lastLogAt = now();
      log(
        `[typecheck-slots] waiting for a host typecheck slot${forLabel(label)}: ${holders.length}/${slots} held (${describeHolders(holders)}). ` +
          `Bounded by ${SLOT_COUNT_ENV}=${slots} across every worktree on this host.`,
      );
    }
    await sleep(pollMs / 2 + Math.random() * pollMs);
  }
}
