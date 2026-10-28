/**
 * Host-wide heavy-check slots: at most N heavy repository checks (Vitest
 * selections, `docs:truth:gate`, the learning-guide build, the pre-push
 * gates, local verification-coordinator requests) run at once on this
 * machine, across every worktree and caller.
 *
 * Why this exists: three agents on one 4-core, 15 GiB host each ran
 * pre-push hooks, readiness and docs gates at once; load reached ~10 and a
 * Station server on the same host was starved into a restart. Each check
 * bounds its own parallelism, and none could see the others.
 *
 * The protocol is the typecheck pool's (`typecheck-host-slots.mjs`): atomic
 * link(2) claims, pid plus birth-fingerprint liveness, dead-holder reclaim,
 * and a bounded wait that fails naming the holders. This is a second pool
 * with its own directory, count and held marker, and it admits waiters in
 * arrival order (FIFO tickets) so a waiter cannot lose every round.
 *
 * ## Nesting and lock order
 *
 * A holder exports `STATION_HEAVY_CHECK_SLOT_HELD=<pid>[:<birth>]`; a
 * descendant that asks for a slot while that exact process is alive is
 * admitted under its ancestor's slot instead of waiting on it. A marker
 * naming a dead or recycled pid is ignored and the caller queues normally.
 *
 * Admission is taken in one order: heavy-check slot, then the verification
 * coordinator, then typecheck or Biome slots. `run-verification.mjs request`
 * takes a heavy-check slot before it asks the coordinator for admission, and
 * every lane the coordinator runs gives its children the marker of the
 * process running it (`verification-request-context.mjs`). A coordinator lane
 * therefore never waits on a heavy-check slot, so a request holding a slot
 * while it waits for coordinator capacity cannot deadlock against a running
 * lane.
 *
 * Hosted CI (`GITHUB_ACTIONS=true`) takes no slot: each runner is a single
 * tenant, and a pool there would only serialize one job's own steps. `CI`
 * alone does not exempt a run, because local tools set it too.
 */
import {
  availableParallelism,
  tmpdir as osTmpdir,
  totalmem as osTotalmem,
} from 'node:os';
import { join } from 'node:path';
import {
  acquireTypecheckSlot,
  holderIsLive,
  ownBirthFingerprint,
} from './typecheck-host-slots.mjs';

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
 */
function resolveHeavyCheckSlotDirectory({
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

/**
 * The live holder `env`'s marker names, or null. The marker is the holder's
 * pid and, where cheap to read, its birth fingerprint, so a recycled pid does
 * not inherit an old holder's admission.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ pidAlive?: (pid: number) => boolean, lookupBirth?: (pid: number) => string | null }} [liveness]
 */
function liveMarkedHolder(env, liveness = {}) {
  const match = /^([1-9]\d*)(?::(.+))?$/.exec(env[HEAVY_CHECK_HELD_ENV] ?? '');
  if (!match) return null;
  const record = {
    pid: Number(match[1]),
    start: match[2] ?? null,
    acquiredAt: Date.now(),
  };
  return holderIsLive(record, liveness) ? record.pid : null;
}

/**
 * `env` marking the process `pid` as the heavy-check holder for its
 * descendants: the slot runner after it claims a slot, `run-verification`
 * after it claims one, and the coordinator for the lanes it runs.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [pid]
 */
export function withHeavyCheckHeld(env, pid = process.pid) {
  const start = ownBirthFingerprint({ pid });
  return {
    ...env,
    [HEAVY_CHECK_HELD_ENV]: start ? `${pid}:${start}` : String(pid),
  };
}

/**
 * Wait (bounded, first come first served) for a host-wide heavy-check slot.
 *
 * `skipped` means hosted CI, where no pool applies; `reentrant` means a live
 * ancestor already holds one. Both print one line saying so. Otherwise the
 * caller holds slot `index` until it calls `release` or exits. Throws a
 * `FAIL:` error naming the holders when the wait runs out.
 *
 * @param {{
 *   label?: string,
 *   env?: NodeJS.ProcessEnv,
 *   pidAlive?: (pid: number) => boolean,
 *   lookupBirth?: (pid: number) => string | null,
 *   log?: (message: string) => void,
 * } & Record<string, unknown>} [options] Remaining options pass through to `acquireTypecheckSlot` (test seams).
 * @returns {Promise<{ index: number, dir: string, slots: number, reentrant: boolean, skipped: boolean, release: () => void }>}
 */
export async function acquireHeavyCheckSlot({
  label = '',
  env = process.env,
  pidAlive,
  lookupBirth,
  log = (message) => process.stderr.write(`${message}\n`),
  ...seams
} = {}) {
  const dir = resolveHeavyCheckSlotDirectory({ env });
  const unheld = {
    index: -1,
    dir,
    slots: 0,
    release: () => {},
  };
  if (env.GITHUB_ACTIONS === 'true') {
    log(
      `[heavy-check-slots] hosted CI (GITHUB_ACTIONS=true): ${label || 'check'} runs without a host slot.`,
    );
    return { ...unheld, reentrant: false, skipped: true };
  }
  const liveness = {
    ...(pidAlive ? { pidAlive } : {}),
    ...(lookupBirth ? { lookupBirth } : {}),
  };
  const ancestor = liveMarkedHolder(env, liveness);
  if (ancestor !== null) {
    log(
      `[heavy-check-slots] ${label || 'check'} runs under the heavy-check slot held by pid ${ancestor}.`,
    );
    return { ...unheld, reentrant: true, skipped: false };
  }
  const ownEnv = { ...env };
  delete ownEnv[HEAVY_CHECK_HELD_ENV];
  const slot = await acquireTypecheckSlot({
    label,
    env: ownEnv,
    dir,
    slots: resolveHeavyCheckSlotCount({ env }),
    waitMs: resolveWaitMs(env),
    pool: HEAVY_CHECK_POOL,
    fifo: true,
    log,
    ...liveness,
    ...seams,
  });
  return { ...slot, skipped: false };
}
