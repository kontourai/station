import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where `fallow audit` keeps its base snapshot for one run (#2529).
 *
 * `fallow audit` attributes findings to a changeset by materialising a full
 * checkout of the base commit (~380 MB for this repository) in the process
 * temp directory, as `fallow-audit-base-cache-<hash>-root-<hash>` plus
 * `.last-used`, `.lock` and `.sha` files, and never removes it. Every lane's
 * merge-base differs, so the system temp directory filled a 926 GB disk
 * (648 checkouts, ~43 GB, in a day).
 *
 * Each run therefore gets a private temp directory under
 * `<Station temp root>/fallow/`, removed when the run ends. Nothing is shared
 * between runs, so no run can remove a checkout another is reading. Sharing
 * would need to know which checkouts are in use, and fallow cannot say:
 * it writes those stamps once, at creation, never on reuse, and `.lock` is a
 * plain file rather than an OS lock. What sharing would save is small:
 * fallow's own per-worktree analysis cache (`.fallow/`) usually spares the
 * checkout entirely, and a miss costs about nine seconds.
 *
 * A run that is killed before its `finally` leaves its directory behind. Runs
 * are bounded at two minutes (`runFallowAnalysis`), so a run directory older
 * than {@link FALLOW_RUN_DIRECTORY_MAX_AGE_MS} belongs to no live run, and the
 * next run removes it.
 */

/** Older than this, a run directory belongs to no live run (runs are bounded at two minutes). */
export const FALLOW_RUN_DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;

const RUN_DIRECTORY_PREFIX = 'run-';

/**
 * The directory that holds run directories. Mirrors `stationTempRoot()` in
 * packages/shared/src/temp-dir.ts (`STATION_TEMP_ROOT`, else
 * `<os tmpdir>/station`), which a script cannot import.
 */
export function fallowTempRoot(env = process.env) {
  const root =
    env.STATION_TEMP_ROOT && env.STATION_TEMP_ROOT.length > 0
      ? env.STATION_TEMP_ROOT
      : join(tmpdir(), 'station');
  return join(root, 'fallow');
}

/** The environment a fallow child runs with: every temp variable points at its run directory. */
export function fallowChildEnvironment(directory, env = process.env) {
  return { ...env, TMPDIR: directory, TMP: directory, TEMP: directory };
}

/**
 * Remove run directories older than {@link FALLOW_RUN_DIRECTORY_MAX_AGE_MS}.
 * Returns the names removed. Never throws: anything it cannot read or remove
 * is left for the next run.
 */
export function removeAbandonedFallowRuns(
  root,
  { now = Date.now(), maxAgeMs = FALLOW_RUN_DIRECTORY_MAX_AGE_MS } = {},
) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of entries) {
    if (!name.startsWith(RUN_DIRECTORY_PREFIX)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Left for the next run.
    }
  }
  return removed;
}

/**
 * Create this run's private temp directory (after clearing abandoned ones).
 * Returns it and a `release` that removes it; call `release` when fallow exits.
 */
export function prepareFallowRun(env = process.env) {
  const root = fallowTempRoot(env);
  mkdirSync(root, { recursive: true });
  removeAbandonedFallowRuns(root);
  const directory = mkdtempSync(join(root, RUN_DIRECTORY_PREFIX));
  return {
    directory,
    release: () => rmSync(directory, { recursive: true, force: true }),
  };
}
