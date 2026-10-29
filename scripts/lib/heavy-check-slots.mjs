/**
 * Host-wide heavy-check slots: at most N heavy repository checks (Vitest
 * selections, `docs:truth:gate`, the learning-guide build, the pre-push
 * gates, executing verification-coordinator lanes and full-regression
 * phases) run at once on this machine, across every worktree and caller.
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
 * A holder exports `STATION_HEAVY_CHECK_SLOT_HELD` naming its exact claim
 * (slot directory, index and nonce); a descendant that asks for a slot while
 * that claim is still held by a live process is admitted under it instead of
 * waiting on it. A marker for a released, reclaimed or dead claim is ignored
 * and the caller queues normally.
 *
 * Admission is taken in one order: verification-coordinator admission, then
 * a heavy-check slot, then typecheck or Biome slots. A coordinator owner takes
 * its slot only once a lane (`withHeavyCheckSlot`) or one full-regression
 * phase (`holdHeavyCheckSlot`) has been admitted and is about to execute, and
 * releases it before the next phase queues, so no slot is held while waiting
 * on the coordinator.
 * Reused and joined requests take none. Heavy checks run through
 * `scripts/heavy-check-slot.mjs` never call the coordinator; a check that did,
 * and joined another owner's lane, would wait on an owner waiting for its own
 * slot until one bounded wait failed.
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
  liveSlotClaim,
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
 * The live claim `env`'s marker names (its holder's pid, null when unknown),
 * or null when there is none. The marker names
 * one exact slot claim (directory, index, nonce), so it admits only while
 * that claim is still held by a live process: not after the slot was
 * released, not after its holder died, and not when the pid was recycled.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ pidAlive?: (pid: number) => boolean, lookupBirth?: (pid: number) => string | null }} [liveness]
 */
function liveMarkedHolder(env, liveness = {}) {
  let claim;
  try {
    claim = JSON.parse(env[HEAVY_CHECK_HELD_ENV] ?? '');
  } catch {
    return null;
  }
  if (
    typeof claim?.dir !== 'string' ||
    !Number.isInteger(claim.index) ||
    claim.index < 0 ||
    typeof claim.nonce !== 'string'
  )
    return null;
  const held = liveSlotClaim(claim.dir, claim.index, claim.nonce, liveness);
  return held ? { pid: held.pid ?? null } : null;
}

/**
 * `env` marking the claim `slot` as the heavy-check holder for its
 * descendants: the slot runner, or a coordinator owner, after it claims a
 * slot.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ dir: string, index: number, nonce?: string }} slot
 */
export function withHeavyCheckHeld(env, slot) {
  return {
    ...env,
    [HEAVY_CHECK_HELD_ENV]: JSON.stringify({
      dir: slot.dir,
      index: slot.index,
      nonce: slot.nonce,
    }),
  };
}

function abortError() {
  const error = new Error('canceled while waiting for a heavy-check slot');
  error.name = 'AbortError';
  return error;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Take a heavy-check slot for verification work that coordinator admission
 * has already admitted, before that work's own execution clock starts.
 * Resolves to the environment its children inherit (carrying this holder's
 * marker) and a `release`. The wait is bounded by the configured wait and by
 * `deadline`; it rejects with `FAIL:` naming the holders when that runs out,
 * or with an `AbortError` when `signal` aborts. With no slot to take
 * (hosted CI, or a live ancestor holding one) it returns synchronously.
 *
 * @param {{ label: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, deadline?: number, now?: () => number }} admission
 * @returns {{ env: NodeJS.ProcessEnv, release: () => void } | Promise<{ env: NodeJS.ProcessEnv, release: () => void }>}
 */
export function holdHeavyCheckSlot({
  label,
  env,
  signal,
  deadline,
  now = Date.now,
}) {
  if (admittedWithoutSlot({ label, env })) return { env, release: () => {} };
  return (async () => {
    if (signal?.aborted) throw abortError();
    const slot = await acquireHeavyCheckSlot({
      label,
      env,
      sleep: (ms) => abortableSleep(ms, signal),
      ...(Number.isFinite(deadline)
        ? {
            waitMs: Math.max(0, Math.min(resolveWaitMs(env), deadline - now())),
          }
        : {}),
    });
    // Admitted without a claim of its own (an ancestor's claim became
    // readable in between): its children keep the inherited marker.
    return {
      env: slot.index >= 0 ? withHeavyCheckHeld(env, slot) : env,
      release: slot.release,
    };
  })();
}

/**
 * Wrap a verification `execute({ signal, ... })` so it runs holding a
 * heavy-check slot, for work whose deadline already covers queueing (an
 * ordinary coordinator lane). The wait runs inside that deadline and abort
 * signal: a refusal rejects, which the deadline runner turns into the
 * execution's failed result, and an abort is reported as SIGTERM like any
 * other canceled execution. `buildExecute(env)` builds the real execute with
 * the environment its children inherit. If an execution is fenced because it
 * never settled, its slot stays held until this process exits.
 *
 * @param {{ label: string, env: NodeJS.ProcessEnv }} admission
 * @param {(env: NodeJS.ProcessEnv) => (run: any) => Promise<any>} buildExecute
 */
export function withHeavyCheckSlot({ label, env }, buildExecute) {
  return (run) => {
    const held = holdHeavyCheckSlot({ label, env, signal: run?.signal });
    // Without a slot to take, start the execution synchronously, as the
    // deadline runner's callers have always seen it start.
    if (!(held instanceof Promise))
      return buildExecute(held.env)({ ...run, env: held.env });
    return held.then(
      async ({ env: childEnv, release }) => {
        try {
          return await buildExecute(childEnv)({ ...run, env: childEnv });
        } finally {
          release();
        }
      },
      (error) => {
        if (error?.name === 'AbortError')
          return { status: null, signal: 'SIGTERM' };
        throw error;
      },
    );
  };
}

/**
 * Hosted CI, or a live ancestor holding a slot: either way no slot is taken,
 * and one line says why. Returns which, or null when the caller must queue.
 *
 * @returns {'skipped' | 'reentrant' | null}
 */
function admittedWithoutSlot({
  label,
  env,
  liveness = {},
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  if (env.GITHUB_ACTIONS === 'true') {
    log(
      `[heavy-check-slots] hosted CI (GITHUB_ACTIONS=true): ${label || 'check'} runs without a host slot.`,
    );
    return 'skipped';
  }
  const ancestor = liveMarkedHolder(env, liveness);
  if (ancestor === null) return null;
  log(
    `[heavy-check-slots] ${label || 'check'} runs under the heavy-check slot held by pid ${ancestor.pid ?? 'unknown'}.`,
  );
  return 'reentrant';
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
 *   announceBypass?: boolean,
 * } & Record<string, unknown>} [options] Remaining options pass through to `acquireTypecheckSlot` (test seams).
 * @returns {Promise<{ index: number, dir: string, slots: number, reentrant: boolean, skipped: boolean, release: () => void }>}
 */
export async function acquireHeavyCheckSlot({
  label = '',
  env = process.env,
  pidAlive,
  lookupBirth,
  log = (message) => process.stderr.write(`${message}\n`),
  // tsc-slot's stderr is read as compiler diagnostics, so it stays silent
  // when no slot is needed; waiting and refusal still report.
  announceBypass = true,
  ...seams
} = {}) {
  const dir = resolveHeavyCheckSlotDirectory({ env });
  const liveness = {
    ...(pidAlive ? { pidAlive } : {}),
    ...(lookupBirth ? { lookupBirth } : {}),
  };
  const bypass = admittedWithoutSlot({
    label,
    env,
    liveness,
    log: announceBypass ? log : () => {},
  });
  if (bypass)
    return {
      index: -1,
      dir,
      slots: 0,
      reentrant: bypass === 'reentrant',
      skipped: bypass === 'skipped',
      release: () => {},
    };
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
