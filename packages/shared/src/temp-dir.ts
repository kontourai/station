/**
 * Station-scoped temporary directories.
 *
 * Every short-lived directory Station creates lives under a single
 * `<os-tmpdir>/station/` root instead of being scattered across the system
 * temp directory. That matters for two reasons:
 *
 *  1. **Cleanup is possible.** A crashed or killed process cannot run its own
 *     teardown, so leaked directories accumulate forever. With one root, a
 *     sweeper can reclaim them without pattern-matching the whole system temp
 *     directory.
 *  2. **Leak assertions stay cheap.** Scanning the system temp directory is
 *     O(everything on the machine); scanning the Station root is O(Station).
 *     A test that verified "no staging directories leaked" by reading the
 *     system temp directory took 3.1s per call once unrelated processes had
 *     filled it with ~790k entries.
 */

import { mkdirSync, mkdtemp, mkdtempSync, rm, rmSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);

/** Directory name used for the Station-owned temp root. */
export const STATION_TEMP_ROOT_NAME = 'station';

/**
 * Absolute path of the Station-owned temp root.
 *
 * `STATION_TEMP_ROOT` overrides it so a test run, a sandbox, or a packaged
 * desktop build can redirect every Station temp artifact into a directory it
 * controls and can delete wholesale.
 */
export function stationTempRoot(): string {
  const override = process.env.STATION_TEMP_ROOT;
  return override && override.length > 0
    ? override
    : join(tmpdir(), STATION_TEMP_ROOT_NAME);
}

function ensureRootSync(): string {
  const root = stationTempRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Create a uniquely named directory under the Station temp root.
 *
 * `prefix` names the purpose (`'registry-plugin'`, `'plugin-update'`). It is a
 * label, not a path — separators are rejected so a caller cannot escape the
 * root.
 */
export function createStationTempDirSync(prefix: string): string {
  return mkdtempSync(join(ensureRootSync(), `${assertLabel(prefix)}-`));
}

/** Async counterpart to {@link createStationTempDirSync}. */
export async function createStationTempDir(prefix: string): Promise<string> {
  const root = stationTempRoot();
  await mkdir(root, { recursive: true });
  return mkdtempAsync(join(root, `${assertLabel(prefix)}-`));
}

/** Remove a directory created by this module. Never throws. */
export function removeStationTempDirSync(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** Async counterpart to {@link removeStationTempDirSync}. Never throws. */
export async function removeStationTempDir(directory: string): Promise<void> {
  await rmAsync(directory, { recursive: true, force: true }).catch(() => {});
}

/**
 * Entries currently under the Station temp root, newest-agnostic and
 * optionally filtered by the `prefix` passed at creation time.
 *
 * Leak assertions use this instead of reading the system temp directory.
 */
export async function listStationTempEntries(
  prefix?: string,
): Promise<string[]> {
  const entries = await readdir(stationTempRoot()).catch(() => [] as string[]);
  return prefix ? entries.filter((e) => e.startsWith(`${prefix}-`)) : entries;
}

/**
 * Delete Station temp directories last modified more than `maxAgeMs` ago.
 *
 * Directories still in use by a live process are younger than any sensible
 * age threshold, so an age-based sweep is safe to run at startup. Returns the
 * number of directories reclaimed.
 */
export async function sweepStationTempRoot(
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const root = stationTempRoot();
  const entries = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - maxAgeMs;
  let reclaimed = 0;

  for (const entry of entries) {
    const target = join(root, entry);
    const info = await stat(target).catch(() => null);
    if (!info || info.mtimeMs > cutoff) continue;
    await rmAsync(target, { recursive: true, force: true }).catch(() => null);
    reclaimed += 1;
  }

  return reclaimed;
}

function assertLabel(prefix: string): string {
  if (!prefix || /[\\/]|\.\./.test(prefix)) {
    throw new Error(
      `Station temp prefix must be a plain label, received: ${prefix}`,
    );
  }
  return prefix;
}
