import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where `fallow audit` keeps its base snapshots, and how many it may keep (#2529).
 *
 * `fallow audit` attributes findings to a changeset by materialising a full
 * checkout of the base commit (~380 MB for this repository) under the process
 * temp directory, as `fallow-audit-base-cache-<hash>-root-<hash>` plus
 * `.last-used`, `.lock` and `.sha` sidecar files. It reuses one for the same
 * base but never removes any, and every lane's merge-base differs, so the
 * system temp directory filled a 926 GB disk (648 caches, ~43 GB, in a day).
 *
 * The audit therefore runs with its temp directory inside Station's own temp
 * root (the same root `sweepStationTempRoot` owns), and each run first prunes
 * that directory down to the most recently used caches. A cache used within
 * {@link FALLOW_BASE_CACHE_IN_USE_MS} is never removed, whatever its rank: an
 * audit is bounded at two minutes, so a concurrent lane's cache is always
 * inside that window.
 */

export const FALLOW_BASE_CACHE_PREFIX = 'fallow-audit-base-cache-';

/** How many most-recently-used base snapshots survive a prune. */
export const FALLOW_BASE_CACHE_KEEP = 4;

/** A cache used this recently may belong to a running audit; never removed. */
export const FALLOW_BASE_CACHE_IN_USE_MS = 15 * 60 * 1000;

const SIDECARS = ['.last-used', '.lock', '.sha'];

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

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Remove base snapshots beyond the {@link FALLOW_BASE_CACHE_KEEP} most recently
 * used, skipping any used within {@link FALLOW_BASE_CACHE_IN_USE_MS}. "Used"
 * is fallow's own `.last-used` stamp (or its `.lock`, or the directory itself
 * when neither exists). Returns the names removed. Never throws: a prune that
 * cannot read or remove something leaves it for the next run.
 */
export function pruneFallowBaseCaches(
  directory,
  {
    now = Date.now(),
    keep = FALLOW_BASE_CACHE_KEEP,
    inUseMs = FALLOW_BASE_CACHE_IN_USE_MS,
  } = {},
) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const caches = entries
    .filter(
      (name) =>
        name.startsWith(FALLOW_BASE_CACHE_PREFIX) &&
        !SIDECARS.some((suffix) => name.endsWith(suffix)),
    )
    .map((name) => {
      const base = join(directory, name);
      const used = Math.max(
        ...[`${base}.last-used`, `${base}.lock`, base]
          .map(mtimeMs)
          .filter((value) => value !== undefined),
        0,
      );
      return { name, base, used };
    })
    .sort((a, b) => b.used - a.used);

  const removed = [];
  for (const [rank, cache] of caches.entries()) {
    if (rank < keep || now - cache.used < inUseMs) continue;
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

/** Prepare fallow's temp directory for one run: create it and prune it. */
export function prepareFallowTempDirectory(env = process.env) {
  const directory = fallowTempDirectory(env);
  mkdirSync(directory, { recursive: true });
  pruneFallowBaseCaches(directory);
  return directory;
}
