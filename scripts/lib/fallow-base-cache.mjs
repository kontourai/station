import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
 * Each run therefore gets a private directory under the fallow cache root
 * ({@link resolveFallowCacheRoot}), removed when the run ends. The root is
 * disk-backed on purpose (#5080): where `/tmp` is tmpfs, a checkout under
 * `os.tmpdir()` is RAM charged to the caller's memory cgroup, about 1.2 GiB
 * on the host whose Station engine was OOM-killed beside a 5 GiB audit.
 * Nothing is shared between runs. Sharing would need to know which checkouts are in use, and
 * fallow cannot say: it writes those stamps once, at creation, never on reuse,
 * and `.lock` is a plain file rather than an OS lock. What sharing would save
 * is one checkout per audit whose base fallow's per-worktree analysis cache
 * (`.fallow/`) has not seen: repeated runs against an unchanged base skip the
 * checkout, but a new base (main moved, a fresh worktree) builds one, about
 * nine seconds here.
 *
 * A run that is killed before its `finally` leaves its directory behind. Runs
 * are bounded at four minutes (`runFallowAnalysis`), so a run directory older
 * than {@link FALLOW_RUN_DIRECTORY_MAX_AGE_MS} belongs to no live run, and the
 * next run removes it. That rests on the bound being enforced: if the audit
 * script itself dies and the fallow child it detached then hangs for over an
 * hour, a later run would remove the hung child's directory.
 */

/** Older than this, a run directory belongs to no live run (runs are bounded at four minutes). */
const FALLOW_RUN_DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;

const RUN_DIRECTORY_PREFIX = 'run-';

/** Overrides the directory that holds run directories. */
const FALLOW_CACHE_DIR_ENV = 'STATION_FALLOW_CACHE_DIR';

/**
 * The directory that holds run directories: `STATION_FALLOW_CACHE_DIR`, else
 * `$XDG_CACHE_HOME/station/fallow` (when absolute, as the XDG spec requires),
 * else `~/.cache/station/fallow`. Never `os.tmpdir()` by default, which is RAM
 * on a tmpfs host (#5080).
 *
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: string }} [options]
 */
export function resolveFallowCacheRoot({
  env = process.env,
  homedir = osHomedir(),
} = {}) {
  if (env[FALLOW_CACHE_DIR_ENV]) return env[FALLOW_CACHE_DIR_ENV];
  const xdg = env.XDG_CACHE_HOME;
  const cacheHome = xdg && isAbsolute(xdg) ? xdg : join(homedir, '.cache');
  return join(cacheHome, 'station', 'fallow');
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
 * Create this run's private directory (after clearing abandoned ones).
 * Returns it and a `release` that removes it; call `release` when fallow exits.
 */
export function prepareFallowRun(env = process.env) {
  const root = resolveFallowCacheRoot({ env });
  // Owner-only: a run directory holds a full checkout of the base commit.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  removeAbandonedFallowRuns(root);
  const directory = mkdtempSync(join(root, RUN_DIRECTORY_PREFIX));
  return {
    directory,
    release: () => rmSync(directory, { recursive: true, force: true }),
  };
}
