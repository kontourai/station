import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where `fallow audit` keeps its base snapshots, and which it may delete (#2529).
 *
 * `fallow audit` attributes findings to a changeset by materialising a full
 * checkout of the base commit (~380 MB for this repository) under the process
 * temp directory, as `fallow-audit-base-cache-<hash>-root-<hash>` plus
 * `.last-used`, `.lock` and `.sha` sidecar files (`.sha` holds the base
 * commit). It reuses one for the same base but never removes any, and every
 * lane's merge-base differs, so the system temp directory filled a 926 GB disk
 * (648 caches, ~43 GB, in a day).
 *
 * The audit therefore runs with its temp directory inside Station's temp root,
 * and each run prunes that directory to the {@link FALLOW_BASE_CACHE_KEEP} most
 * recently created caches. fallow's own stamps cannot say what is in use: it
 * writes `.lock`, `.last-used` and `.sha` once, when it creates a cache, and
 * never again on reuse, and `.lock` is a plain file, not an OS lock. So use is
 * recorded here instead:
 *
 * - Each run writes a marker (`run-<pid>-<nonce>.json`) naming every base
 *   commit fallow may pick for it, before it prunes, and removes it when fallow
 *   exits. A cache whose `.sha` names a live run's base is never removed, nor
 *   is one still being created (no `.sha` yet, `.lock` younger than
 *   {@link FALLOW_BASE_CACHE_CREATING_MS}).
 * - Pruning holds `prune.lock`, and a run does not start fallow until it has
 *   held and released it. So a run whose marker lands after another run read
 *   the markers waits for that prune to finish before fallow can reuse
 *   anything it deleted.
 * - The markers change this directory's mtime on every run, so Station's
 *   24-hour `sweepStationTempRoot` can only remove it after a day with no
 *   audit, when nothing here is in use.
 */

export const FALLOW_BASE_CACHE_PREFIX = 'fallow-audit-base-cache-';

/** How many unprotected base snapshots survive a prune, most recent first. */
export const FALLOW_BASE_CACHE_KEEP = 4;

/** A cache with no `.sha` whose `.lock` is younger than this is being created. */
export const FALLOW_BASE_CACHE_CREATING_MS = 15 * 60 * 1000;

/**
 * At most this many caches go per prune, so the lock is held for seconds, not
 * minutes; a backlog drains over the following runs.
 */
export const FALLOW_PRUNE_MAX_REMOVALS = 16;

/** How long a run waits for another run's prune before starting without one. */
export const FALLOW_PRUNE_LOCK_WAIT_MS = 120 * 1000;

const SIDECARS = ['.last-used', '.lock', '.sha'];
const PRUNE_LOCK = 'prune.lock';
const RUN_MARKER = /^run-(\d+)-[0-9a-z]+\.json$/;

/**
 * The directory fallow uses as its temp directory. Mirrors `stationTempRoot()`
 * in packages/shared/src/temp-dir.ts (`STATION_TEMP_ROOT`, else
 * `<os tmpdir>/station`), which a script cannot import.
 */
export function fallowTempDirectory(env = process.env) {
  const root =
    env.STATION_TEMP_ROOT && env.STATION_TEMP_ROOT.length > 0
      ? env.STATION_TEMP_ROOT
      : join(tmpdir(), 'station');
  return join(root, 'fallow');
}

/** The environment a fallow child runs with: every temp variable points into the Station root. */
export function fallowChildEnvironment(directory, env = process.env) {
  return { ...env, TMPDIR: directory, TMP: directory, TEMP: directory };
}

/**
 * Every base commit `fallow audit` may pick in `root`: an explicit
 * `FALLOW_AUDIT_BASE`, else the merge-base against the branch's upstream or
 * the remote default (`origin/HEAD`, `origin/main`, `origin/master`). Listing
 * more than it will pick only protects more; a ref that does not resolve is
 * skipped.
 */
export function candidateAuditBases(root, env = process.env) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
    } catch {
      return undefined;
    }
  };
  const bases = new Set();
  if (env.FALLOW_AUDIT_BASE) {
    const explicit = git(
      'rev-parse',
      '--verify',
      `${env.FALLOW_AUDIT_BASE}^{commit}`,
    );
    if (explicit) bases.add(explicit);
  }
  for (const ref of [
    '@{upstream}',
    'origin/HEAD',
    'origin/main',
    'origin/master',
  ]) {
    const base = git('merge-base', 'HEAD', ref);
    if (base) bases.add(base);
  }
  return [...bases];
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Base commits named by live runs' markers; a dead run's marker is removed. */
function protectedBases(directory) {
  const bases = new Set();
  let entries = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return bases;
  }
  for (const name of entries) {
    const match = RUN_MARKER.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    if (!processIsAlive(Number(match[1]))) {
      rmSync(path, { force: true });
      continue;
    }
    try {
      for (const base of JSON.parse(readFileSync(path, 'utf8')).bases ?? [])
        bases.add(base);
    } catch {
      // A marker being written: its run also waits for the prune lock.
    }
  }
  return bases;
}

/**
 * Remove base snapshots beyond the {@link FALLOW_BASE_CACHE_KEEP} most recent,
 * never one a live run may use or one still being created. Returns the names
 * removed. Never throws: anything it cannot read or remove is left for the next
 * prune. Callers other than tests hold the prune lock
 * ({@link prepareFallowRun}).
 */
export function pruneFallowBaseCaches(
  directory,
  {
    now = Date.now(),
    keep = FALLOW_BASE_CACHE_KEEP,
    creatingMs = FALLOW_BASE_CACHE_CREATING_MS,
    maxRemovals = FALLOW_PRUNE_MAX_REMOVALS,
  } = {},
) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const inUse = protectedBases(directory);
  const caches = entries
    .filter(
      (name) =>
        name.startsWith(FALLOW_BASE_CACHE_PREFIX) &&
        !SIDECARS.some((suffix) => name.endsWith(suffix)),
    )
    .map((name) => {
      const base = join(directory, name);
      let sha;
      try {
        sha = readFileSync(`${base}.sha`, 'utf8').trim();
      } catch {
        sha = undefined;
      }
      const created = Math.max(
        ...[`${base}.lock`, `${base}.last-used`, base]
          .map(mtimeMs)
          .filter((value) => value !== undefined),
        0,
      );
      return { name, base, sha, created };
    })
    .sort((a, b) => b.created - a.created);

  const removed = [];
  for (const [rank, cache] of caches.entries()) {
    if (removed.length >= maxRemovals) break;
    if (rank < keep) continue;
    if (cache.sha !== undefined && inUse.has(cache.sha)) continue;
    if (cache.sha === undefined && now - cache.created < creatingMs) continue;
    try {
      rmSync(cache.base, { recursive: true, force: true });
      for (const suffix of SIDECARS)
        rmSync(`${cache.base}${suffix}`, { force: true });
      removed.push(cache.name);
    } catch {
      // Left for the next prune.
    }
  }
  return removed;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take the prune lock, breaking one whose holder is dead. False on timeout. */
function acquirePruneLock(directory, waitMs) {
  const lock = join(directory, PRUNE_LOCK);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
    }
    let holder;
    try {
      holder = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    } catch {
      holder = undefined;
    }
    if (holder !== undefined && !processIsAlive(holder)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return false;
    sleep(200);
  }
}

/**
 * Prepare fallow's temp directory for one run in `root`: create it, record the
 * run's candidate bases, and prune under the prune lock. Returns the directory
 * and a `release` that removes the run's marker; call it when fallow exits.
 */
export function prepareFallowRun(root, env = process.env, options = {}) {
  const directory = fallowTempDirectory(env);
  mkdirSync(directory, { recursive: true });
  const marker = join(
    directory,
    `run-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  writeFileSync(
    marker,
    JSON.stringify({ pid: process.pid, bases: candidateAuditBases(root, env) }),
  );
  if (
    acquirePruneLock(directory, options.lockWaitMs ?? FALLOW_PRUNE_LOCK_WAIT_MS)
  ) {
    try {
      pruneFallowBaseCaches(directory);
    } finally {
      rmSync(join(directory, PRUNE_LOCK), { recursive: true, force: true });
    }
  }
  return {
    directory,
    release: () => rmSync(marker, { force: true }),
  };
}
