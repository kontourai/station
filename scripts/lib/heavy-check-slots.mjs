/**
 * Host-wide heavy-check slots: at most N heavy repository checks (Vitest
 * selections, `docs:truth:gate`, the learning-guide build, the pre-push
 * gates) run at once on this machine, across every worktree and caller.
 *
 * Why this exists: three agents on one 4-core, 15 GiB host each ran
 * pre-push hooks, readiness and docs gates at once; load reached ~10 and a
 * Station server on the same host was starved into a restart. Each check
 * bounds its own parallelism, and none could see the others.
 *
 * The protocol is the typecheck pool's (`typecheck-host-slots.mjs`): atomic
 * link(2) claims, pid plus birth-fingerprint liveness, dead-holder reclaim,
 * and a bounded wait that fails naming the holders. This is a second pool
 * with its own directory, count and held marker.
 *
 * ## Nesting and lock order
 *
 * A holder exports `STATION_HEAVY_CHECK_SLOT_HELD=<its pid>`; a descendant
 * that asks for a slot while that pid is alive is admitted under its
 * ancestor's slot instead of waiting on it. A marker naming a dead pid (a
 * leaked environment) is ignored and the caller queues normally.
 *
 * The verification coordinator (`ci:fast`, `verify:static`,
 * `full:regression`) is already a host-wide, pressure-gated admission, so its
 * children carry the marker for the coordinator's pid
 * (`verification-request-context.mjs`). Admission is therefore always taken
 * in one order -- coordinator, then heavy check, then typecheck or Biome --
 * and no holder ever waits on an admission that a waiter for its own slot
 * holds.
 *
 * Hosted CI (`CI` or `GITHUB_ACTIONS`) takes no slot: each runner is a single
 * tenant, and a pool there would only serialize one job's own steps.
 */
import { availableParallelism, tmpdir as osTmpdir, totalmem as osTotalmem } from 'node:os';
import { join } from 'node:path';
import { acquireTypecheckSlot } from './typecheck-host-slots.mjs';

export const HEAVY_CHECK_HELD_ENV = 'STATION_HEAVY_CHECK_SLOT_HELD';
const COUNT_ENV = 'STATION_HEAVY_CHECK_SLOTS';
const WAIT_ENV = 'STATION_HEAVY_CHECK_SLOT_WAIT_MS';
const DIR_ENV = 'STATION_HEAVY_CHECK_SLOT_DIR';

const HEAVY_CHECK_POOL = Object.freeze({
  tag: 'heavy-check-slots',
  noun: 'heavy-check slot',
  heldEnv: HEAVY_CHECK_HELD_ENV,
  countEnv: COUNT_ENV,
  waitEnv: WAIT_ENV,
  dirEnv: DIR_ENV,
});

const GIB = 1024 ** 3;
/**
 * A heavy check saturates about four cores (a four-lane aggregate, or a
 * Vitest pool) and can hold several GiB, so N is the smaller of one slot per
 * four logical CPUs (floored) and one per 8 GiB (rounded), between 1 and 4.
 * The 4-core, 15 GiB host that motivated this gets 1.
 */
const CPUS_PER_SLOT = 4;
const BYTES_PER_SLOT = 8 * GIB;
const MAX_DEFAULT_SLOTS = 4;
const MAX_CONFIGURED_SLOTS = 64;
/** Longer than any single heavy check, short enough that a hung holder surfaces. */
const DEFAULT_WAIT_MS = 30 * 60_000;

/**
 * @param {{ env?: NodeJS.ProcessEnv, cpus?: number, totalmem?: number }} [options]
 */
export function resolveHeavyCheckSlotCount({
  env = process.env,
  cpus = availableParallelism(),
  totalmem = osTotalmem(),
} = {}) {
  const raw = env[COUNT_ENV];
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_CONFIGURED_SLOTS
    )
      throw new Error(
        `${COUNT_ENV}=${JSON.stringify(raw)} is not an integer between 1 and ${MAX_CONFIGURED_SLOTS}`,
      );
    return parsed;
  }
  return Math.max(
    1,
    Math.min(
      MAX_DEFAULT_SLOTS,
      Math.floor(cpus / CPUS_PER_SLOT),
      Math.round(totalmem / BYTES_PER_SLOT),
    ),
  );
}

/**
 * The one directory every caller on this host shares; see
 * `resolveSlotDirectory` in `typecheck-host-slots.mjs` for why POSIX uses a
 * fixed uid-scoped `/tmp` path rather than `os.tmpdir()`.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, uid?: number, tmpdir?: string }} [options]
 */
export function resolveHeavyCheckSlotDirectory({
  env = process.env,
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : -1,
  tmpdir = osTmpdir(),
} = {}) {
  if (env[DIR_ENV]) return env[DIR_ENV];
  if (platform === 'win32') return join(tmpdir, 'station-heavy-check-slots');
  return `/tmp/station-heavy-check-slots-${uid}`;
}

function resolveWaitMs(env) {
  const raw = env[WAIT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(
      `${WAIT_ENV}=${JSON.stringify(raw)} is not a non-negative integer (milliseconds)`,
    );
  return parsed;
}

function isHostedCi(env) {
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true';
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
 * Whether `env` carries the marker of a live ancestor holder. A malformed
 * marker or one naming a dead pid does not admit anything.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {(pid: number) => boolean} [pidAlive]
 */
export function heldByLiveAncestor(env, pidAlive = defaultPidAlive) {
  const raw = env[HEAVY_CHECK_HELD_ENV];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return false;
  return pidAlive(Number(raw));
}

/**
 * `env` with this process marked as the heavy-check holder for its
 * descendants: the slot runner after it claims a slot, and the verification
 * coordinator for the lanes it has admitted.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [pid]
 */
export function withHeavyCheckHeld(env, pid = process.pid) {
  return { ...env, [HEAVY_CHECK_HELD_ENV]: String(pid) };
}

/**
 * Wait (bounded) for a host-wide heavy-check slot.
 *
 * `skipped` means hosted CI, where no pool applies; `reentrant` means a live
 * ancestor already holds one. Otherwise the caller holds slot `index` until
 * it calls `release` or exits. Throws a `FAIL:` error naming the holders when
 * the wait runs out.
 *
 * @param {{
 *   label?: string,
 *   env?: NodeJS.ProcessEnv,
 *   pidAlive?: (pid: number) => boolean,
 * } & Record<string, unknown>} [options] Remaining options pass through to `acquireTypecheckSlot` (test seams).
 * @returns {Promise<{ index: number, dir: string, slots: number, reentrant: boolean, skipped: boolean, release: () => void }>}
 */
export async function acquireHeavyCheckSlot({
  label = '',
  env = process.env,
  pidAlive,
  ...seams
} = {}) {
  const dir = resolveHeavyCheckSlotDirectory({ env });
  if (isHostedCi(env))
    return {
      index: -1,
      dir,
      slots: 0,
      reentrant: false,
      skipped: true,
      release: () => {},
    };
  const slots = resolveHeavyCheckSlotCount({ env });
  const waitMs = resolveWaitMs(env);
  const ownEnv = { ...env };
  if (!heldByLiveAncestor(env, pidAlive)) delete ownEnv[HEAVY_CHECK_HELD_ENV];
  const slot = await acquireTypecheckSlot({
    label,
    env: ownEnv,
    dir,
    slots,
    waitMs,
    pool: HEAVY_CHECK_POOL,
    ...(pidAlive ? { pidAlive } : {}),
    ...seams,
  });
  return { ...slot, skipped: false };
}
